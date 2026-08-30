import { randomUUID } from "node:crypto";
import { z } from "zod";
// Codex-specific, and deliberately so: its only consumer is onRunnerEvent,
// which reads Codex's own stdout stream. Runtime-agnostic span building goes
// through the injected trace adapter instead.
import { readStreamError } from "../../runtimes/codex.js";
import { readOtlpLogs, type OtlpLogRecord } from "./otlp.js";
import type { PartialUsage, RuntimeTraceAdapter } from "./runtime-events.js";
import { detectSecretBindings } from "./secrets.js";
import type { Redactor } from "./redaction.js";
import type {
  SpanActor,
  SpanKind,
  SpanStatus,
  TraceSpan,
} from "./trace-model.js";
import {
  emptyUsage,
  hasJudgeableEvidence,
  isAuditorTrace,
} from "./trace-model.js";
import { classifyRunFailure, type RunFailure } from "../../failures.js";
import type { TraceStore } from "./trace-store.js";

interface RunStartAgent {
  id: string;
  name: string;
  instructions: string;
  codexThreadId: string | null;
}

interface RunStartInput {
  id: string;
  prompt: string;
  // Set when this run is an audit of another trace. Carried onto the record so
  // the automatic audit subscription can tell an agent's run from an auditor's
  // and fire only for the former.
  auditOf?: string | null | undefined;
  auditDepth?: number | undefined;
}

interface RunEndInput {
  status: "completed" | "failed" | "cancelled";
  error?: string | null;
  output?: string | null;
  // Reported by runtimes that resolve their model at run time (Claude Code).
  // Applied only when the trace has no model yet, so Codex's authoritative
  // conversation_starts value is never overwritten.
  model?: string | null;
  // Which layer is at fault and what to do about it. Recorded on the trace so
  // the run list can say why a run failed, not merely that it did.
  failure?: RunFailure | null;
}

interface ConversationScope {
  spawnSpanId: string | null;
  subagentStack: string[];
  modelCallsInTurn: number;
  toolsSinceLastModelCall: string[];
  lastToolOutput: string | null;
  lastModelCallSpanId: string | null;
}

interface RunState {
  agentId: string;
  rootSpanId: string;
  promptSpanId: string;
  prompt: string;
  rootConversationId: string | null;
  turnSpanId: string | null;
  toolSpans: Map<string, string>;
  scopes: Map<string, ConversationScope>;
  conversationSpawn: Map<string, string>;
  completed: boolean;
}

function emptyConversationScope(spawnSpanId: string | null): ConversationScope {
  return {
    spawnSpanId,
    subagentStack: spawnSpanId ? [spawnSpanId] : [],
    modelCallsInTurn: 0,
    toolsSinceLastModelCall: [],
    lastToolOutput: null,
    lastModelCallSpanId: null,
  };
}

const OUTPUT_CLIP = 4_000;
const ARGUMENT_CLIP = 2_000;
const PENDING_TTL_MS = 5 * 60_000;
const PENDING_CAP = 1_000;

function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) + " …[truncated " + (text.length - limit) + " chars]"
  );
}

function preview(text: string, limit = 80) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1) + "…";
}

// "Summarize · Model · plan" → the step the auditor asked about.
function auditorCallSubject(label: string) {
  const sep = " · ";
  const index = label.indexOf(sep);
  if (index <= 0) return undefined;
  const subject = label.slice(index + sep.length).trim();
  return subject.length > 0 ? subject : undefined;
}

function isSubagentTool(toolName: string) {
  const normalized = toolName.toLowerCase();
  if (normalized === "task") return true;
  if (normalized === "spawn_agent") return true;
  if (normalized.endsWith("/spawn_agent")) return true;
  return false;
}

function isSameThreadSubagentTool(toolName: string) {
  return toolName.toLowerCase() === "task";
}

const subagentArgumentsSchema = z.object({
  subagent_type: z.string().min(1).optional(),
  subagentType: z.string().min(1).optional(),
  agent_type: z.string().min(1).optional(),
  task_name: z.string().min(1).optional(),
  receiver_thread_ids: z.array(z.string()).optional(),
  receiverThreadIds: z.array(z.string()).optional(),
  thread_ids: z.array(z.string()).optional(),
  thread_id: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});

function parseSubagentArguments(argumentsJson: string | undefined) {
  if (!argumentsJson) return null;
  try {
    const parsed = subagentArgumentsSchema.safeParse(JSON.parse(argumentsJson));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function readSubagentLabel(argumentsJson: string | undefined) {
  const parsed = parseSubagentArguments(argumentsJson);
  if (!parsed) return null;
  return (
    parsed.subagent_type ??
    parsed.subagentType ??
    parsed.agent_type ??
    parsed.task_name ??
    null
  );
}

function readChildThreadIds(
  argumentsJson: string | undefined,
  extra: string[] = [],
) {
  const parsed = parseSubagentArguments(argumentsJson);
  const ids = [
    ...extra,
    ...(parsed?.receiver_thread_ids ?? []),
    ...(parsed?.receiverThreadIds ?? []),
    ...(parsed?.thread_ids ?? []),
  ];
  if (parsed?.thread_id) ids.push(parsed.thread_id);
  if (parsed?.threadId) ids.push(parsed.threadId);
  return [...new Set(ids.filter((id) => id.length > 0))];
}

// Codex states the exit status two different ways: as a summary line above the
// output of a command that ran, and as a struct field inside the envelope of
// one that was denied. Both were being discarded.
const EXIT_PATTERNS = [
  /Process exited with code (-?\d+)/,
  /\bexit_code:\s*(-?\d+)/,
];

function readExitCode(output: string): number | null {
  for (const pattern of EXIT_PATTERNS) {
    const match = pattern.exec(output);
    if (match) return Number(match[1]);
  }
  return null;
}

// A non-zero exit alone is not a failure — `grep` finding nothing and `diff`
// seeing a difference both exit non-zero as ordinary control flow. It is a
// failure when the output also carries a recognisable failure signature, which
// is exactly the question the taxonomy already answers.
function readCommandFailure(output: string): RunFailure | null {
  const exitCode = readExitCode(output);
  if (exitCode === null || exitCode === 0) return null;
  const failure = classifyRunFailure(output, {
    exitCode,
    source: "tool-step",
  });
  return failure.kind === "unknown" ? null : failure;
}

const runnerCompletedItemSchema = z.object({
  type: z.string(),
  tool: z.string().optional(),
  id: z.string().optional(),
  status: z.string().optional(),
  prompt: z.string().optional(),
  text: z.string().optional(),
  receiver_thread_ids: z.array(z.string()).optional(),
});

function modelCallLabel(scope: ConversationScope, attempt: number | undefined) {
  const nested =
    scope.spawnSpanId !== null || scope.subagentStack.length > 0;
  const prefix = nested ? "Subagent model" : "Model";
  let label: string;
  if (scope.toolsSinceLastModelCall.length === 0) {
    label =
      scope.modelCallsInTurn === 0
        ? prefix + " · plan"
        : prefix + " · continue";
  } else {
    const lastTool =
      scope.toolsSinceLastModelCall[scope.toolsSinceLastModelCall.length - 1]!;
    label = prefix + " · after " + lastTool;
  }
  if (attempt !== undefined && attempt > 0) {
    label += " (retry " + attempt + ")";
  }
  return label;
}

export class TraceService {
  private readonly conversationToRun = new Map<string, string>();
  private readonly runs = new Map<string, RunState>();
  private readonly activeRunByAgent = new Map<string, string>();
  private readonly pending = new Map<
    string,
    { records: OtlpLogRecord[]; since: number }
  >();

  constructor(
    private readonly store: TraceStore,
    private readonly redactor: Redactor,
    private readonly traceAdapter: RuntimeTraceAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  redactText(text: string) {
    return this.redactor.redactText(text);
  }

  // Credential detection has to happen before masking: once a value is
  // replaced by asterisks its shape is gone and the auditor can no longer name
  // it. Only the names are kept — the values never reach a span.
  private secretNames(text: string | undefined) {
    if (!text) return [];
    return detectSecretBindings(text).map((binding) => binding.secretType);
  }

  private appendModelOutput(
    runId: string,
    spanId: string | null,
    text: string,
    options: { onlyIfEmpty?: boolean } = {},
  ) {
    if (!spanId || text.length === 0) return;
    const redacted = this.redactor.redactText(text);
    if (redacted.length === 0) return;
    // Only the transition from "no output" to "some output" is announced. The
    // span is appended before the model has said anything, so that first write
    // is the moment it becomes judgeable; later appends would re-announce the
    // same step and have it audited again.
    let spoke = false;
    this.store.updateSpan(runId, spanId, (span) => {
      if (span.kind !== "model_call") return;
      if (span.status === "error") return;
      const existing = span.attributes.output;
      if (typeof existing === "string" && existing.length > 0) {
        if (options.onlyIfEmpty) return;
        span.attributes.output = existing + "\n" + redacted;
        return;
      }
      span.attributes.output = redacted;
      spoke = true;
    });
    if (spoke) this.store.emitSpan(runId, spanId);
  }

  onRunStart(agent: RunStartAgent, run: RunStartInput) {
    const startedAt = this.now().toISOString();
    const prompt = this.redactor.redactText(run.prompt);
    const rootSpanId = randomUUID();
    const promptSpanId = randomUUID();
    const auditOf = run.auditOf ?? null;
    this.store.create({
      version: 1,
      id: run.id,
      agentId: agent.id,
      conversationId: agent.codexThreadId,
      status: "running",
      startedAt,
      endedAt: null,
      prompt,
      model: null,
      usage: emptyUsage(),
      failingSpanId: null,
      failure: null,
      recoveredErrorCount: 0,
      evidenceComplete: true,
      unrecognizedEvents: 0,
      auditOf: run.auditOf ?? null,
      auditDepth: run.auditDepth ?? 0,
      spans: [],
    });
    this.store.appendSpan(run.id, {
      id: rootSpanId,
      traceId: run.id,
      parentId: null,
      name: "agent.run",
      // An auditor's run is named for what it judged. "Agent run · Auditor"
      // read as though the Agent were called Auditor.
      label: auditOf
        ? "Audit of run " + auditOf.slice(0, 8)
        : "Agent run · " + agent.name,
      kind: "run",
      actor: "agent",
      status: "running",
      startedAt,
      endedAt: null,
      durationMs: null,
      attributes: {
        agentId: agent.id,
        agentName: agent.name,
        instructions: this.redactor.redactText(agent.instructions),
      },
      error: null,
    });
    this.store.appendSpan(run.id, {
      id: promptSpanId,
      traceId: run.id,
      parentId: rootSpanId,
      name: "user.prompt",
      label: 'Prompt "' + preview(prompt, 48) + '"',
      kind: "user_action",
      actor: "user",
      status: "ok",
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      attributes: {
        prompt,
        promptLength: prompt.length,
        // Nobody prompted the auditor. Its prompt is a sentence this service
        // wrote to open the trace, so it is kept for the record but is not a
        // step the auditor took — layoutOnly is what the step list, the
        // timeline and the canvas all read to tell those apart.
        ...(auditOf ? { layoutOnly: true } : {}),
      },
      error: null,
    });
    this.runs.set(run.id, {
      agentId: agent.id,
      rootSpanId,
      promptSpanId,
      prompt,
      rootConversationId: agent.codexThreadId,
      turnSpanId: null,
      toolSpans: new Map(),
      scopes: new Map(),
      conversationSpawn: new Map(),
      completed: false,
    });
    // An auditor's run shares the Agent's id but is not the Agent running, so
    // it must not become what "the Agent's active run" resolves to. Terminating
    // an Agent mid-audit would otherwise file the intervention on the auditor's
    // trace instead of on the run the user was actually stopping.
    if (!isAuditorTrace({ auditOf: run.auditOf ?? null })) {
      this.activeRunByAgent.set(agent.id, run.id);
    }
    if (agent.codexThreadId) {
      this.bindConversation(agent.codexThreadId, run.id);
    }
  }

  // The runtime has named the conversation this run belongs to. Until this
  // lands, every OTLP record the runtime exports correlates to an id nothing
  // is listening for and is parked in `pending` — so a run whose conversation
  // is never announced ends with a prompt span and nothing else.
  //
  // Announced by the runner through RunnerRequest.onThread rather than
  // sniffed off the event stream here: Codex says it with a `thread.started`
  // event and Claude Code with `system`/`init` carrying `session_id`, and
  // each runtime's own parser is the only thing that should have to know that.
  onConversation(runId: string, conversationId: string) {
    if (conversationId.length === 0) return;
    const state = this.runs.get(runId);
    if (state) state.rootConversationId = conversationId;
    this.store.updateTrace(runId, (trace) => {
      trace.conversationId = conversationId;
    });
    this.bindConversation(conversationId, runId);
  }

  onRunnerEvent(runId: string, event: Record<string, unknown>) {
    const state = this.runs.get(runId);
    if (!state) return;

    const streamError = readStreamError(event);
    if (streamError !== null) {
      this.recordStreamError(runId, state, streamError);
      return;
    }

    if (event.type !== "item.completed") return;
    const item = runnerCompletedItemSchema.safeParse(event.item);
    if (!item.success) return;

    if (item.data.type === "agent_message" && item.data.text) {
      this.appendModelOutput(
        runId,
        this.rootScope(state).lastModelCallSpanId,
        item.data.text,
      );
      return;
    }

    if (
      item.data.type !== "collab_tool_call" ||
      item.data.tool !== "spawn_agent"
    ) {
      return;
    }

    const timestamp = this.now().toISOString();
    const turnSpanId = this.ensureTurn(runId, state, timestamp);
    const caller = this.rootScope(state);
    const callId = item.data.id ?? randomUUID();
    const existing = state.toolSpans.get(callId);
    const receiverThreadIds = item.data.receiver_thread_ids ?? [];
    const prompt = item.data.prompt ?? null;
    const completed = item.data.status === "completed";

    if (existing) {
      // Emitted so a subagent that finishes through the runner event stream is
      // audited like any other completed tool call.
      this.store.updateSpan(
        runId,
        existing,
        (span) => {
          span.attributes.subagent = true;
          if (receiverThreadIds.length > 0) {
            span.attributes.receiverThreadIds = receiverThreadIds.join(",");
          }
          if (prompt) span.attributes.prompt = this.redactor.redactText(prompt);
          if (completed && span.status === "running") span.status = "ok";
        },
        { emit: completed },
      );
      this.attachChildConversations(
        runId,
        state,
        existing,
        receiverThreadIds,
        caller,
      );
      if (completed) this.popSubagentScope(caller, existing);
      return;
    }

    const spanId = randomUUID();
    state.toolSpans.set(callId, spanId);
    const parentId = this.activeParent(caller, turnSpanId);
    this.store.appendSpan(runId, {
      id: spanId,
      traceId: runId,
      parentId,
      name: "tool.spawn_agent",
      label: "Subagent task",
      kind: "tool_call",
      actor: "agent",
      status: completed ? "ok" : "running",
      startedAt: timestamp,
      endedAt: completed ? timestamp : null,
      durationMs: completed ? 0 : null,
      attributes: {
        toolName: "spawn_agent",
        callId,
        subagent: true,
        laneId: this.laneIdFor(caller, true),
        ...(receiverThreadIds.length > 0
          ? { receiverThreadIds: receiverThreadIds.join(",") }
          : {}),
        ...(prompt ? { prompt: this.redactor.redactText(prompt) } : {}),
      },
      error: null,
    });
    this.attachChildConversations(
      runId,
      state,
      spanId,
      receiverThreadIds,
      caller,
    );
  }

  // Codex reports its own failures on the event stream. The runners collected
  // them and then read only the last one, and only when the process also exited
  // non-zero — so every error a run recovered from was discarded before anyone
  // could see it. Turning each into a span means each gets audited too.
  private recordStreamError(runId: string, state: RunState, message: string) {
    const timestamp = this.now().toISOString();
    const turnSpanId = this.ensureTurn(runId, state, timestamp);
    const scope = this.rootScope(state);
    this.appendChild(runId, this.activeParent(scope, turnSpanId), {
      name: "codex.error",
      label: "Codex error",
      kind: "system",
      actor: "system",
      status: "error",
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      attributes: { laneId: this.laneIdFor(scope, false) },
      error: this.redactor.redactText(message),
    });
  }

  onRunEnd(runId: string, outcome: RunEndInput) {
    const state = this.runs.get(runId);
    if (!state || state.completed) return;
    state.completed = true;
    const endedAt = this.now().toISOString();
    const failed = outcome.status === "failed";
    const error = outcome.error
      ? this.redactor.redactText(outcome.error)
      : null;

    if (outcome.model) {
      this.store.updateTrace(runId, (trace) => {
        trace.model = trace.model ?? outcome.model ?? null;
      });
    }

    for (const spanId of state.toolSpans.values()) {
      this.store.updateSpan(runId, spanId, (span) => {
        if (span.status !== "running") return;
        span.status = failed ? "error" : "ok";
        span.endedAt = endedAt;
        span.error = failed
          ? "Run ended before the tool reported a result"
          : null;
      });
    }
    if (state.turnSpanId) {
      this.closeSpan(
        runId,
        state.turnSpanId,
        endedAt,
        failed ? "error" : "ok",
        error,
      );
    }
    const rootScope = this.rootScope(state);
    if (rootScope.lastModelCallSpanId) {
      const modelSpanId = rootScope.lastModelCallSpanId;
      this.store.updateSpan(runId, modelSpanId, (span) => {
        if (span.kind !== "model_call" || span.status !== "ok") return;
        if (span.attributes.phase === "after_tool") {
          const prefix = span.label.startsWith("Subagent model")
            ? "Subagent model"
            : "Model";
          span.label = prefix + " · reply";
        }
      });
      if (outcome.output) {
        this.appendModelOutput(runId, modelSpanId, outcome.output, {
          onlyIfEmpty: true,
        });
      }
    }
    if (outcome.failure) {
      const { layer, kind, retryability } = outcome.failure;
      this.store.updateSpan(runId, state.rootSpanId, (span) => {
        span.attributes.failureLayer = layer;
        span.attributes.failureKind = kind;
        span.attributes.retryability = retryability;
      });
    }
    this.closeSpan(
      runId,
      state.rootSpanId,
      endedAt,
      failed ? "error" : "ok",
      error,
    );

    this.store.updateTrace(runId, (trace) => {
      trace.status = outcome.status;
      trace.endedAt = endedAt;
      // The output cap discards the tail of the stream. Say so, rather than
      // letting a diagnosis rest on evidence the platform knows it dropped.
      if (outcome.failure?.kind === "output-cap") {
        trace.evidenceComplete = false;
      }

      // Found whatever the run's outcome was. A sandbox denial that the agent
      // then worked around leaves the run "completed" — and gating the whole
      // diagnosis on the run having failed made that case, the most common one
      // in practice, completely undiagnosable.
      const errored = trace.spans.filter(
        (span) => span.status === "error" && span.id !== state.rootSpanId,
      );
      const failing = errored.at(-1);
      trace.failingSpanId = failing?.id ?? (failed ? state.rootSpanId : null);

      // Counted from the steps that actually failed, not from Codex's stream
      // error events. Those events are rare — a denied command arrives as a
      // tool result, not as a stream error — so counting them reported zero on
      // runs that had visibly recovered from several failures.
      trace.recoveredErrorCount =
        outcome.status === "completed" ? errored.length : 0;

      // The run's own attribution wins; otherwise attribute the step that
      // broke, so `failure` answers "what went wrong here" rather than only
      // "why did this run stop".
      const failingExitCode = failing?.attributes.exitCode;
      // The output is the richer evidence: a command that failed inside an
      // otherwise-successful tool call has no error envelope, only its own
      // stdout and stderr.
      const failingOutput = failing?.attributes.output;
      const evidence =
        (typeof failingOutput === "string" ? failingOutput : "") ||
        failing?.error ||
        "";
      trace.failure =
        outcome.failure ??
        (evidence
          ? classifyRunFailure(evidence, {
              source: "tool-step",
              // Stated inside the envelope, and previously thrown away — the
              // stored failure reported a null exit code for a step that had
              // plainly exited 1.
              exitCode:
                typeof failingExitCode === "number" ? failingExitCode : null,
            })
          : null);
    });

    // Last look for the steps that never got a real one. A tool interrupted
    // before its result, and one denied at its decision, are both final without
    // ever having carried a payload — closing them above is silent, so without
    // this the agent's most interesting steps are the ones nothing ever judged.
    // Deliberately after updateTrace: the auditor only accepts an evidence-less
    // span once the run has a final status, so emitting earlier would be
    // ignored.
    for (const span of this.store.get(runId)?.spans ?? []) {
      if (span.kind !== "tool_call") continue;
      if (hasJudgeableEvidence(span)) continue;
      this.store.emitSpan(runId, span.id);
    }

    if (this.activeRunByAgent.get(state.agentId) === runId) {
      this.activeRunByAgent.delete(state.agentId);
    }
  }

  onUserIntervention(agentId: string, action: "terminate") {
    // Newest first, and an auditor's run is newer than the Agent run it judged,
    // so the fallback has to skip them for the same reason the line above does.
    const runId =
      this.activeRunByAgent.get(agentId) ??
      this.store
        .listByAgent(agentId)
        .find((trace) => !isAuditorTrace(trace))?.id;
    if (!runId) return null;
    const trace = this.store.get(runId);
    if (!trace) return null;
    const parentId =
      trace.spans.find((span) => span.name === "agent.run")?.id ?? null;
    const at = this.now().toISOString();
    return this.store.appendSpan(runId, {
      id: randomUUID(),
      traceId: runId,
      parentId,
      name: "user.intervention",
      label: 'User "Terminated"',
      kind: "user_action",
      actor: "user",
      status: "ok",
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      attributes: { action },
      error: null,
    });
  }

  ingestLogs(payload: unknown) {
    const records = readOtlpLogs(payload);
    if (records === null) {
      return null;
    }
    let accepted = 0;
    let buffered = 0;
    let skipped = 0;
    for (const record of records) {
      const conversationId = record.attributes[this.traceAdapter.correlationAttribute];
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        skipped += 1;
        continue;
      }
      const runId = this.conversationToRun.get(conversationId);
      if (!runId) {
        buffered += this.buffer(conversationId, record);
        continue;
      }
      this.applyRecord(runId, record);
      accepted += 1;
    }
    this.prunePending();
    return { accepted, buffered, skipped };
  }

  private bindConversation(conversationId: string, runId: string) {
    this.conversationToRun.set(conversationId, runId);
    const waiting = this.pending.get(conversationId);
    if (waiting) {
      this.pending.delete(conversationId);
      for (const record of waiting.records) {
        this.applyRecord(runId, record);
      }
    }
  }

  private buffer(conversationId: string, record: OtlpLogRecord) {
    const entry = this.pending.get(conversationId) ?? {
      records: [],
      since: Date.now(),
    };
    if (entry.records.length >= PENDING_CAP) return 0;
    entry.records.push(record);
    this.pending.set(conversationId, entry);
    return 1;
  }

  private prunePending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [conversationId, entry] of this.pending) {
      if (entry.since < cutoff) this.pending.delete(conversationId);
    }
  }

  private applyRecord(runId: string, record: OtlpLogRecord) {
    const state = this.runs.get(runId);
    if (!state) return;
    const timestamp =
      typeof record.timestamp === "string"
        ? record.timestamp
        : this.now().toISOString();
    const normalized = this.traceAdapter.normalize(record.attributes);
    if (!normalized) {
      this.store.updateTrace(runId, (trace) => {
        trace.unrecognizedEvents += 1;
      });
      return;
    }
    const conversationId = record.attributes[this.traceAdapter.correlationAttribute];
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return;
    }
    const scope = this.scopeFor(state, conversationId);
    const isRootScope = scope.spawnSpanId === null;
    const turnSpanId = this.ensureTurn(runId, state, timestamp);

    switch (normalized.kind) {
      case "ignored": {
        return;
      }
      case "generic_error": {
        this.appendChild(runId, this.activeParent(scope, turnSpanId), {
          name: normalized.eventName,
          label: normalized.eventName,
          kind: "system",
          actor: "system",
          status: "error",
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          attributes: { laneId: this.laneIdFor(scope, false) },
          error: this.redactor.redactText(normalized.errorMessage),
        });
        return;
      }
      case "conversation_started": {
        if (!isRootScope) return;
        this.store.updateTrace(runId, (trace) => {
          trace.model = normalized.model ?? trace.model;
        });
        this.store.updateSpan(runId, turnSpanId, (span) => {
          if (normalized.provider) span.attributes.provider = normalized.provider;
          if (normalized.approvalPolicy)
            span.attributes.approvalPolicy = normalized.approvalPolicy;
          if (normalized.sandboxPolicy)
            span.attributes.sandboxPolicy = normalized.sandboxPolicy;
          if (normalized.mcpServers && normalized.mcpServers.length > 0) {
            span.attributes.mcpServers = normalized.mcpServers.join(",");
          }
        });
        return;
      }
      case "user_prompt": {
        if (!isRootScope) return;
        this.store.updateSpan(runId, state.promptSpanId, (span) => {
          // Runtime telemetry sees the middleware envelope. Preserve the
          // original human prompt on this user-action span and record only
          // whether the runtime prompt was wrapped and how long it was.
          span.attributes.runtimePromptLength = normalized.promptLength;
          if (normalized.prompt) {
            span.attributes.runtimePromptWrapped =
              this.redactor.redactText(normalized.prompt) !== state.prompt;
          }
        });
        return;
      }
      case "model_call": {
        const duration = normalized.durationMs;
        const spanId = randomUUID();
        scope.lastModelCallSpanId = spanId;
        const firstInScope =
          scope.modelCallsInTurn === 0 &&
          scope.toolsSinceLastModelCall.length === 0;
        this.store.appendSpan(runId, {
          id: spanId,
          traceId: runId,
          parentId: this.activeParent(scope, turnSpanId),
          name: normalized.spanName,
          label: modelCallLabel(scope, normalized.attempt),
          kind: "model_call",
          actor: "agent",
          status: normalized.failed ? "error" : "ok",
          startedAt: new Date(
            new Date(timestamp).getTime() - duration,
          ).toISOString(),
          endedAt: timestamp,
          durationMs: duration,
          attributes: {
            laneId: this.laneIdFor(scope, false),
            phase:
              scope.toolsSinceLastModelCall.length === 0
                ? scope.modelCallsInTurn === 0
                  ? "plan"
                  : "continue"
                : "after_tool",
            ...(scope.toolsSinceLastModelCall.length > 0
              ? { afterTool: scope.toolsSinceLastModelCall.at(-1)! }
              : {}),
            ...(firstInScope && isRootScope
              ? { context: preview(state.prompt, OUTPUT_CLIP) }
              : scope.toolsSinceLastModelCall.length > 0 && scope.lastToolOutput
                ? { context: scope.lastToolOutput }
                : {}),
            ...(normalized.statusCode !== undefined
              ? { statusCode: normalized.statusCode }
              : {}),
            ...(normalized.attempt !== undefined ? { attempt: normalized.attempt } : {}),
          },
          error: normalized.errorMessage
            ? this.redactor.redactText(normalized.errorMessage)
            : null,
        });
        scope.modelCallsInTurn += 1;
        scope.toolsSinceLastModelCall = [];
        if (normalized.usage) {
          this.applyUsage(runId, scope, normalized.usage);
        }
        return;
      }
      case "model_call_usage": {
        this.applyUsage(runId, scope, normalized.usage);
        return;
      }
      case "stream_error": {
        this.appendChild(runId, this.activeParent(scope, turnSpanId), {
          name: normalized.spanName,
          label: normalized.label ?? "Stream error",
          kind: "system",
          actor: "system",
          status: "error",
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: normalized.durationMs ?? 0,
          attributes: {
            ...(normalized.attributeKind ? { kind: normalized.attributeKind } : {}),
            laneId: this.laneIdFor(scope, false),
          },
          error: this.redactor.redactText(normalized.errorMessage),
        });
        return;
      }
      case "tool_decision": {
        const spanId = randomUUID();
        state.toolSpans.set(normalized.callId, spanId);
        const subagent = isSubagentTool(normalized.toolName);
        const parentId = this.activeParent(scope, turnSpanId);
        this.store.appendSpan(runId, {
          id: spanId,
          traceId: runId,
          parentId,
          name: "tool." + normalized.toolName,
          label: subagent ? "Subagent · task" : "Tool · " + normalized.toolName,
          kind: "tool_call",
          actor: "agent",
          status: normalized.decision === "denied" ? "error" : "running",
          startedAt: timestamp,
          endedAt: null,
          durationMs: null,
          attributes: {
            toolName: normalized.toolName,
            callId: normalized.callId,
            decision: normalized.rawDecision,
            decisionSource: normalized.source,
            laneId: this.laneIdFor(scope, subagent),
            // The model call in flight when this tool call was decided. When
            // the step fails, this is what separates a bad plan from a bad
            // execution. It is an ordering inference over an async event
            // stream, not something the runtime reports, so the UI presents it
            // as a likelihood.
            ...(scope.lastModelCallSpanId
              ? { causedBySpanId: scope.lastModelCallSpanId }
              : {}),
            ...(subagent ? { subagent: true } : {}),
          },
          error:
            normalized.decision === "denied"
              ? "Tool call " + normalized.rawDecision
              : null,
        });
        if (
          isSameThreadSubagentTool(normalized.toolName) &&
          normalized.decision !== "denied"
        ) {
          scope.subagentStack.push(spanId);
        }
        return;
      }
      case "tool_result": {
        const callId = normalized.callId ?? "";
        const existing = state.toolSpans.get(callId);
        const reportedSuccess = normalized.success;
        const output = normalized.output
          ? this.redactor.redactText(clip(normalized.output, OUTPUT_CLIP))
          : "";
        // Codex calls the tool call successful whenever the tool itself ran —
        // a command that exits 127 with "command not found" is reported as a
        // success. That made the agent's own failures invisible: they were the
        // one thing the failure taxonomy exists to identify, and they never
        // produced a failing step.
        //
        // These three all read the tool's output, which Claude Code's OTLP
        // never carries (only input and byte sizes), so for that runtime they
        // resolve to null/false. That is the correct answer for it, not a gap:
        // there is no output to find a command failure in.
        const commandFailure = reportedSuccess
          ? readCommandFailure(normalized.output ?? "")
          : null;
        const succeeded = reportedSuccess && commandFailure === null;
        const exitCode = readExitCode(normalized.output ?? "");
        // Marked rather than merely inlined into the text, so a reader can tell
        // at a glance whether they are looking at the whole picture.
        const outputTruncated = (normalized.output?.length ?? 0) > OUTPUT_CLIP;
        const toolArgumentsRaw = normalized.arguments
          ? this.redactor.redactText(normalized.arguments)
          : "";
        // Arguments are what the agent sent outward; output is what came back.
        const requestSecrets = this.secretNames(normalized.arguments);
        const responseSecrets = this.secretNames(normalized.output).filter(
          (name) => !requestSecrets.includes(name),
        );
        const toolArguments = toolArgumentsRaw
          ? clip(toolArgumentsRaw, ARGUMENT_CLIP)
          : "";
        if (toolArgumentsRaw && scope.lastModelCallSpanId) {
          // Runtimes hand arguments over as a JSON string. Embedding it
          // as-is produced a document whose "arguments" was itself escaped
          // JSON ({"arguments":"{\"cmd\": ...}"}), which no pretty-printer
          // can make readable. Parse first so the panel shows one clean
          // object.
          let parsedArguments: unknown = toolArgumentsRaw;
          try {
            parsedArguments = JSON.parse(toolArgumentsRaw);
          } catch {
            // Not JSON: keep the raw string rather than dropping the call.
          }
          this.appendModelOutput(
            runId,
            scope.lastModelCallSpanId,
            JSON.stringify({
              name: normalized.toolName,
              arguments: parsedArguments,
            }),
          );
        }
        const childThreadIds = readChildThreadIds(normalized.arguments);
        if (existing) {
          this.store.updateSpan(
            runId,
            existing,
            (span) => {
              span.status = succeeded ? "ok" : "error";
              span.endedAt = timestamp;
              span.durationMs = normalized.durationMs;
              if (toolArguments) span.attributes.arguments = toolArguments;
              if (output) span.attributes.output = output;
              if (outputTruncated) {
                span.attributes.outputTruncated = true;
                span.attributes.outputLength = normalized.output?.length ?? 0;
              }
              if (requestSecrets.length > 0) {
                span.attributes.secretsInRequest = requestSecrets.join(",");
              }
              if (responseSecrets.length > 0) {
                span.attributes.secretsInResponse = responseSecrets.join(",");
              }
              if (normalized.mcpServer)
                span.attributes.mcpServer = normalized.mcpServer;
              if (exitCode !== null) span.attributes.exitCode = exitCode;
              span.error = succeeded ? null : clip(output, 400) || "Tool failed";
              if (isSubagentTool(normalized.toolName)) {
                const subagentLabel = readSubagentLabel(toolArguments);
                if (subagentLabel) {
                  span.attributes.subagentType = subagentLabel;
                  span.label = "Subagent · " + subagentLabel;
                }
                if (childThreadIds.length > 0) {
                  span.attributes.receiverThreadIds = childThreadIds.join(",");
                }
              }
            },
            { emit: true },
          );
          if (isSubagentTool(normalized.toolName)) {
            this.attachChildConversations(
              runId,
              state,
              existing,
              childThreadIds,
              scope,
            );
            this.popSubagentScope(scope, existing);
          }
          if (succeeded) {
            scope.toolsSinceLastModelCall.push(normalized.toolName);
            if (output) scope.lastToolOutput = clip(output, OUTPUT_CLIP);
          }
        } else {
          this.appendChild(
            runId,
            this.activeParent(scope, turnSpanId),
            {
              name: "tool." + normalized.toolName,
              label: isSubagentTool(normalized.toolName)
                ? "Subagent task"
                : "Called " + normalized.toolName,
              kind: "tool_call",
              actor: "agent",
              status: succeeded ? "ok" : "error",
              startedAt: new Date(
                new Date(timestamp).getTime() - normalized.durationMs,
              ).toISOString(),
              endedAt: timestamp,
              durationMs: normalized.durationMs,
              attributes: {
                toolName: normalized.toolName,
                callId,
                laneId: this.laneIdFor(scope, isSubagentTool(normalized.toolName)),
                ...(scope.lastModelCallSpanId
                  ? { causedBySpanId: scope.lastModelCallSpanId }
                  : {}),
                ...(isSubagentTool(normalized.toolName) ? { subagent: true } : {}),
                ...(toolArguments ? { arguments: toolArguments } : {}),
                ...(output ? { output } : {}),
                ...(outputTruncated
                  ? {
                      outputTruncated: true,
                      outputLength: normalized.output?.length ?? 0,
                    }
                  : {}),
                ...(requestSecrets.length > 0
                  ? { secretsInRequest: requestSecrets.join(",") }
                  : {}),
                ...(responseSecrets.length > 0
                  ? { secretsInResponse: responseSecrets.join(",") }
                  : {}),
                ...(exitCode !== null ? { exitCode } : {}),
              },
              error: succeeded ? null : clip(output, 400) || "Tool failed",
            },
          );
          if (succeeded) {
            scope.toolsSinceLastModelCall.push(normalized.toolName);
            if (output) scope.lastToolOutput = clip(output, OUTPUT_CLIP);
          }
        }
        return;
      }
      case "turn_ttft": {
        if (!isRootScope) return;
        this.store.updateSpan(runId, turnSpanId, (span) => {
          span.attributes.ttftMs = normalized.durationMs;
        });
        return;
      }
    }
  }

  private applyUsage(runId: string, scope: ConversationScope, usage: PartialUsage) {
    this.store.updateTrace(runId, (trace) => {
      trace.usage.inputTokens += usage.inputTokens ?? 0;
      trace.usage.cachedTokens += usage.cachedTokens ?? 0;
      trace.usage.outputTokens += usage.outputTokens ?? 0;
      trace.usage.reasoningTokens += usage.reasoningTokens ?? 0;
      trace.usage.toolTokens += usage.toolTokens ?? 0;
    });
    if (scope.lastModelCallSpanId) {
      this.store.updateSpan(runId, scope.lastModelCallSpanId, (span) => {
        if (usage.inputTokens !== undefined) {
          span.attributes.inputTokens = usage.inputTokens;
        }
        if (usage.outputTokens !== undefined) {
          span.attributes.outputTokens = usage.outputTokens;
        }
        if (usage.reasoningTokens !== undefined) {
          span.attributes.reasoningTokens = usage.reasoningTokens;
        }
        if (usage.cachedTokens !== undefined) {
          span.attributes.cachedTokens = usage.cachedTokens;
        }
        if (usage.ttftMs !== undefined) {
          span.attributes.ttftMs = usage.ttftMs;
        }
      });
    }
  }

  // An in-process run has no event stream to normalize: the caller made the
  // call itself and already holds the span describing it. Parented directly
  // under the run rather than under a turn, because an auditor does not take
  // turns — it asks a fixed set of questions about one trace and stops.
  //
  // A spawned call is recorded the way Codex records spawn_agent: a tool span
  // on the caller's lane, then the model call parented under it with laneId
  // equal to the spawn. The graph reads those fields and nothing else.
  //
  // Usage is rolled up here so an auditor's run accounts for its tokens the
  // way a runtime's run does, where the same numbers arrive over OTLP.
  recordModelCall(
    runId: string,
    span: TraceSpan,
    options?: { subagentType?: string },
  ) {
    const state = this.runs.get(runId);
    if (!state) return null;
    const trace = this.store.get(runId);
    const callerLane =
      trace && isAuditorTrace(trace) ? "auditor" : "root";
    const subagentType = options?.subagentType;
    const parentId = subagentType
      ? this.createSubagentSpawn(runId, state, callerLane, subagentType, span)
      : state.rootSpanId;
    const appended = this.store.appendSpan(runId, {
      ...span,
      traceId: runId,
      parentId,
      attributes: {
        ...span.attributes,
        laneId: subagentType ? parentId : callerLane,
      },
    });
    if (!appended) return null;
    const input = span.attributes.inputTokens;
    const output = span.attributes.outputTokens;
    if (typeof input === "number" || typeof output === "number") {
      this.store.updateTrace(runId, (trace) => {
        if (typeof input === "number") trace.usage.inputTokens += input;
        if (typeof output === "number") trace.usage.outputTokens += output;
      });
    }
    return appended;
  }

  // Same shape Codex writes for spawn_agent, so layout, indent and delegate
  // edges cannot tell an auditor check from a runner subagent. One spawn per
  // call: collapsing by check kind made every summarize share a lane, so the
  // graph could not say which step the auditor had asked about.
  private createSubagentSpawn(
    runId: string,
    state: RunState,
    callerLane: string,
    subagentType: string,
    call: TraceSpan,
  ) {
    const spanId = randomUUID();
    const callId = "spawn:" + spanId;
    state.toolSpans.set(callId, spanId);
    const targetSpanId = call.attributes.targetSpanId;
    const targetLabel = auditorCallSubject(call.label);
    const completed = call.status !== "running";
    this.store.appendSpan(runId, {
      id: spanId,
      traceId: runId,
      parentId: state.rootSpanId,
      name: "tool.spawn_agent",
      label: "Subagent · " + subagentType,
      kind: "tool_call",
      actor: "agent",
      status: completed ? call.status : "running",
      startedAt: call.startedAt,
      endedAt: completed ? call.endedAt : null,
      durationMs: completed ? call.durationMs : null,
      attributes: {
        toolName: "spawn_agent",
        callId,
        subagent: true,
        subagentType,
        laneId: callerLane,
        arguments: JSON.stringify({ subagent_type: subagentType }),
        ...(typeof targetSpanId === "string" && targetSpanId.length > 0
          ? { targetSpanId }
          : {}),
        ...(targetLabel ? { targetLabel } : {}),
      },
      error: completed && call.status === "error" ? call.error : null,
    });
    return spanId;
  }

  private ensureTurn(runId: string, state: RunState, timestamp: string) {
    if (state.turnSpanId) return state.turnSpanId;
    const spanId = randomUUID();
    state.turnSpanId = spanId;
    this.store.appendSpan(runId, {
      id: spanId,
      traceId: runId,
      parentId: state.rootSpanId,
      name: this.traceAdapter.runtimeId + ".turn",
      label: this.traceAdapter.displayName + " turn",
      kind: "turn",
      actor: "agent",
      status: "running",
      startedAt: timestamp,
      endedAt: null,
      durationMs: null,
      attributes: {},
      error: null,
    });
    return spanId;
  }

  private scopeFor(state: RunState, conversationId: string) {
    const existing = state.scopes.get(conversationId);
    if (existing) return existing;
    const spawnSpanId = state.conversationSpawn.get(conversationId) ?? null;
    const scope = emptyConversationScope(spawnSpanId);
    state.scopes.set(conversationId, scope);
    return scope;
  }

  private rootScope(state: RunState) {
    if (state.rootConversationId) {
      return this.scopeFor(state, state.rootConversationId);
    }
    for (const [conversationId, scope] of state.scopes) {
      if (
        scope.spawnSpanId === null &&
        !state.conversationSpawn.has(conversationId)
      ) {
        return scope;
      }
    }
    const scope = emptyConversationScope(null);
    state.scopes.set("", scope);
    return scope;
  }

  private laneIdFor(scope: ConversationScope, isSpawnNode: boolean) {
    if (isSpawnNode) {
      const caller = scope.subagentStack[scope.subagentStack.length - 1];
      if (caller && caller !== scope.spawnSpanId) return caller;
      return scope.spawnSpanId ?? "root";
    }
    return (
      scope.subagentStack[scope.subagentStack.length - 1] ??
      scope.spawnSpanId ??
      "root"
    );
  }

  private attachChildConversations(
    runId: string,
    state: RunState,
    spawnSpanId: string,
    threadIds: string[],
    caller: ConversationScope,
  ) {
    const childIds = threadIds.filter((threadId) => {
      if (threadId.length === 0) return false;
      if (state.rootConversationId === threadId) return false;
      return true;
    });
    if (childIds.length === 0) return;
    for (const threadId of childIds) {
      state.conversationSpawn.set(threadId, spawnSpanId);
      this.bindConversation(threadId, runId);
    }
    // Child work is on its own conversation, so this spawn must not keep
    // swallowing events on the caller's thread.
    this.popSubagentScope(caller, spawnSpanId);
  }

  private activeParent(scope: ConversationScope, turnSpanId: string) {
    return (
      scope.subagentStack[scope.subagentStack.length - 1] ??
      scope.spawnSpanId ??
      turnSpanId
    );
  }

  private popSubagentScope(scope: ConversationScope, spanId: string) {
    const index = scope.subagentStack.indexOf(spanId);
    if (index >= 0) {
      scope.subagentStack.splice(index, 1);
    }
  }

  private appendChild(
    runId: string,
    parentId: string,
    span: {
      name: string;
      label: string;
      kind: SpanKind;
      actor: SpanActor;
      status: SpanStatus;
      startedAt: string;
      endedAt: string | null;
      durationMs: number | null;
      attributes: Record<string, string | number | boolean>;
      error: string | null;
    },
  ) {
    const id = randomUUID();
    this.store.appendSpan(runId, {
      id,
      traceId: runId,
      parentId,
      ...span,
    });
    return id;
  }

  private closeSpan(
    runId: string,
    spanId: string,
    endedAt: string,
    status: SpanStatus,
    error: string | null,
  ) {
    this.store.updateSpan(runId, spanId, (span) => {
      if (span.status !== "running") return;
      span.status = status;
      span.endedAt = endedAt;
      span.durationMs =
        new Date(endedAt).getTime() - new Date(span.startedAt).getTime();
      if (error && status === "error") span.error = error;
    });
  }
}
