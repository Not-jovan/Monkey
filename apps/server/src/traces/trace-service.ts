import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseCodexEvent } from "./codex-events.js";
import { readOtlpLogs, type OtlpLogRecord } from "./otlp.js";
import type { Redactor } from "./redaction.js";
import type {
  AgentLifecycleType,
  SpanActor,
  SpanKind,
  SpanStatus,
  TraceSpan,
} from "./trace-model.js";
import { emptyUsage } from "./trace-model.js";
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
}

interface RunEndInput {
  status: "completed" | "failed" | "cancelled";
  error?: string | null;
  output?: string | null;
}

interface RunState {
  agentId: string;
  rootSpanId: string;
  promptSpanId: string;
  prompt: string;
  turnSpanId: string | null;
  toolSpans: Map<string, string>;
  subagentStack: string[];
  modelCallsInTurn: number;
  toolsSinceLastModelCall: string[];
  lastToolOutput: string | null;
  lastModelCallSpanId: string | null;
  completed: boolean;
}

const OUTPUT_CLIP = 4_000;
const ARGUMENT_CLIP = 2_000;
const PENDING_TTL_MS = 5 * 60_000;
const PENDING_CAP = 1_000;

function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + " …[truncated " + (text.length - limit) + " chars]";
}

function preview(text: string, limit = 80) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1) + "…";
}

function isSubagentTool(toolName: string) {
  const normalized = toolName.toLowerCase();
  if (normalized === "task") return true;
  if (normalized === "spawn_agent") return true;
  if (normalized.endsWith("/spawn_agent")) return true;
  return false;
}

const subagentArgumentsSchema = z.object({
  subagent_type: z.string().min(1).optional(),
  subagentType: z.string().min(1).optional(),
  agent_type: z.string().min(1).optional(),
  task_name: z.string().min(1).optional(),
});

function readSubagentLabel(argumentsJson: string | undefined) {
  if (!argumentsJson) return null;
  try {
    const parsed = subagentArgumentsSchema.safeParse(JSON.parse(argumentsJson));
    if (!parsed.success) return null;
    return (
      parsed.data.subagent_type ??
      parsed.data.subagentType ??
      parsed.data.agent_type ??
      parsed.data.task_name ??
      null
    );
  } catch {
    return null;
  }
}

const subagentResultPayloadSchema = z.object({
  timestamp: z.number().optional(),
});

function extractSimulatedSubagentResults(output: string) {
  const results: {
    index: string;
    payload: string;
    timestamp: number | null;
  }[] = [];
  for (const match of output.matchAll(/Agent-(\d+) returned:\s*(\{[^}]+\})/g)) {
    let timestamp: number | null = null;
    try {
      const parsed = subagentResultPayloadSchema.safeParse(JSON.parse(match[2]!));
      if (parsed.success && parsed.data.timestamp !== undefined) {
        timestamp = parsed.data.timestamp;
      }
    } catch {
      // Ignore malformed payload fragments in tool output.
    }
    results.push({
      index: match[1]!,
      payload: match[2]!,
      timestamp,
    });
  }
  return results;
}

function modelCallLabel(state: RunState, attempt: number | undefined) {
  const prefix = state.subagentStack.length > 0 ? "Subagent model" : "Model";
  let label: string;
  if (state.toolsSinceLastModelCall.length === 0) {
    label = state.modelCallsInTurn === 0 ? prefix + " · plan" : prefix + " · continue";
  } else {
    const lastTool =
      state.toolsSinceLastModelCall[state.toolsSinceLastModelCall.length - 1]!;
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
    private readonly now: () => Date = () => new Date(),
  ) {}

  redactText(text: string) {
    return this.redactor.redactText(text);
  }

  onRunStart(agent: RunStartAgent, run: RunStartInput) {
    const startedAt = this.now().toISOString();
    const prompt = this.redactor.redactText(run.prompt);
    const rootSpanId = randomUUID();
    const promptSpanId = randomUUID();
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
      unrecognizedEvents: 0,
      spans: [],
    });
    this.store.appendSpan(run.id, {
      id: rootSpanId,
      traceId: run.id,
      parentId: null,
      name: "agent.run",
      label: "Agent run · " + agent.name,
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
      attributes: { prompt },
      error: null,
    });
    this.runs.set(run.id, {
      agentId: agent.id,
      rootSpanId,
      promptSpanId,
      prompt,
      turnSpanId: null,
      toolSpans: new Map(),
      subagentStack: [],
      modelCallsInTurn: 0,
      toolsSinceLastModelCall: [],
      lastToolOutput: null,
      lastModelCallSpanId: null,
      completed: false,
    });
    this.activeRunByAgent.set(agent.id, run.id);
    if (agent.codexThreadId) {
      this.bindConversation(agent.codexThreadId, run.id);
    }
  }

  onRunnerEvent(runId: string, event: Record<string, unknown>) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      this.store.updateTrace(runId, (trace) => {
        trace.conversationId = event.thread_id as string;
      });
      this.bindConversation(event.thread_id, runId);
      return;
    }

    const state = this.runs.get(runId);
    if (!state) return;

    if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") {
      return;
    }

    const item = event.item as Record<string, unknown>;
    if (item.type !== "collab_tool_call" || item.tool !== "spawn_agent") {
      return;
    }

    const timestamp = this.now().toISOString();
    const turnSpanId = this.ensureTurn(runId, state, timestamp);
    const callId = typeof item.id === "string" ? item.id : randomUUID();
    const existing = state.toolSpans.get(callId);
    const receiverThreadIds = Array.isArray(item.receiver_thread_ids)
      ? item.receiver_thread_ids.filter((entry): entry is string => typeof entry === "string")
      : [];
    const prompt = typeof item.prompt === "string" ? item.prompt : null;
    const completed = item.status === "completed";

    if (existing) {
      this.store.updateSpan(runId, existing, (span) => {
        span.attributes.subagent = true;
        if (receiverThreadIds.length > 0) {
          span.attributes.receiverThreadIds = receiverThreadIds.join(",");
        }
        if (prompt) span.attributes.prompt = this.redactor.redactText(prompt);
        if (completed && span.status === "running") span.status = "ok";
      });
      if (completed) this.popSubagentScope(state, existing);
      return;
    }

    const spanId = randomUUID();
    state.toolSpans.set(callId, spanId);
    const parentId = this.activeParent(state, turnSpanId);
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
        ...(receiverThreadIds.length > 0
          ? { receiverThreadIds: receiverThreadIds.join(",") }
          : {}),
        ...(prompt ? { prompt: this.redactor.redactText(prompt) } : {}),
      },
      error: null,
    });
    if (!completed) state.subagentStack.push(spanId);
  }

  onRunEnd(runId: string, outcome: RunEndInput) {
    const state = this.runs.get(runId);
    if (!state || state.completed) return;
    state.completed = true;
    const endedAt = this.now().toISOString();
    const failed = outcome.status === "failed";
    const error = outcome.error ? this.redactor.redactText(outcome.error) : null;

    for (const spanId of state.toolSpans.values()) {
      this.store.updateSpan(runId, spanId, (span) => {
        if (span.status !== "running") return;
        span.status = failed ? "error" : "ok";
        span.endedAt = endedAt;
        span.error = failed ? "Run ended before the tool reported a result" : null;
      });
    }
    if (state.turnSpanId) {
      this.closeSpan(runId, state.turnSpanId, endedAt, failed ? "error" : "ok", error);
    }
    if (state.lastModelCallSpanId) {
      this.store.updateSpan(runId, state.lastModelCallSpanId, (span) => {
        if (span.kind !== "model_call" || span.status !== "ok") return;
        if (span.attributes.phase !== "after_tool") return;
        const prefix = span.label.startsWith("Subagent model") ? "Subagent model" : "Model";
        span.label = prefix + " · reply";
        if (outcome.output) {
          span.attributes.context = this.redactor.redactText(
            clip(outcome.output, OUTPUT_CLIP),
          );
        }
      });
    }
    this.closeSpan(runId, state.rootSpanId, endedAt, failed ? "error" : "ok", error);

    this.store.updateTrace(runId, (trace) => {
      trace.status = outcome.status;
      trace.endedAt = endedAt;
      if (failed) {
        const failing = [...trace.spans]
          .reverse()
          .find((span) => span.status === "error" && span.id !== state.rootSpanId);
        trace.failingSpanId = failing?.id ?? state.rootSpanId;
      }
    });
    if (this.activeRunByAgent.get(state.agentId) === runId) {
      this.activeRunByAgent.delete(state.agentId);
    }
  }

  onUserIntervention(agentId: string, action: "terminate") {
    const runId = this.activeRunByAgent.get(agentId);
    if (!runId) return null;
    const state = this.runs.get(runId);
    if (!state) return null;
    const at = this.now().toISOString();
    return this.store.appendSpan(runId, {
      id: randomUUID(),
      traceId: runId,
      parentId: state.rootSpanId,
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

  recordLifecycle(agentId: string, type: AgentLifecycleType, details: string) {
    return this.store.recordLifecycle({
      id: randomUUID(),
      agentId,
      type,
      at: this.now().toISOString(),
      details: this.redactor.redactText(details),
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
      const conversationId = record.attributes["conversation.id"];
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
    const parsed = parseCodexEvent(record.attributes);
    if (!parsed) {
      this.store.updateTrace(runId, (trace) => {
        trace.unrecognizedEvents += 1;
      });
      return;
    }
    const { event, common } = parsed;
    const turnSpanId = this.ensureTurn(runId, state, timestamp);

    switch (event["event.name"]) {
      case "codex.conversation_starts": {
        this.store.updateTrace(runId, (trace) => {
          trace.model = common.model ?? trace.model;
        });
        this.store.updateSpan(runId, turnSpanId, (span) => {
          span.attributes.provider = event.provider_name;
          if (event.approval_policy) span.attributes.approvalPolicy = event.approval_policy;
          if (event.sandbox_policy) span.attributes.sandboxPolicy = event.sandbox_policy;
          if (event.mcp_servers.length > 0) {
            span.attributes.mcpServers = event.mcp_servers.join(",");
          }
        });
        return;
      }
      case "codex.user_prompt": {
        this.store.updateSpan(runId, state.promptSpanId, (span) => {
          span.attributes.promptLength = event.prompt_length;
          if (event.prompt) {
            span.attributes.prompt = this.redactor.redactText(event.prompt);
          }
        });
        return;
      }
      case "codex.api_request": {
        const duration = event.duration_ms ?? 0;
        const failedRequest =
          event["error.message"] !== undefined ||
          (event["http.response.status_code"] ?? 200) >= 400;
        const spanId = randomUUID();
        state.lastModelCallSpanId = spanId;
        this.store.appendSpan(runId, {
          id: spanId,
          traceId: runId,
          parentId: this.activeParent(state, turnSpanId),
          name: "codex.api_request",
          label: modelCallLabel(state, event.attempt),
          kind: "model_call",
          actor: "agent",
          status: failedRequest ? "error" : "ok",
          startedAt: new Date(new Date(timestamp).getTime() - duration).toISOString(),
          endedAt: timestamp,
          durationMs: duration,
          attributes: {
            phase:
              state.toolsSinceLastModelCall.length === 0
                ? state.modelCallsInTurn === 0
                  ? "plan"
                  : "continue"
                : "after_tool",
            ...(state.toolsSinceLastModelCall.length > 0
              ? { afterTool: state.toolsSinceLastModelCall.at(-1)! }
              : {}),
            ...(state.modelCallsInTurn === 0 &&
            state.toolsSinceLastModelCall.length === 0
              ? { context: preview(state.prompt, OUTPUT_CLIP) }
              : state.toolsSinceLastModelCall.length > 0 && state.lastToolOutput
                ? { context: state.lastToolOutput }
                : {}),
            ...(event["http.response.status_code"] !== undefined
              ? { statusCode: event["http.response.status_code"] }
              : {}),
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
          },
          error: event["error.message"]
            ? this.redactor.redactText(event["error.message"])
            : null,
        });
        state.modelCallsInTurn += 1;
        state.toolsSinceLastModelCall = [];
        return;
      }
      case "codex.sse_event": {
        if (event["event.kind"] === "response.completed") {
          this.store.updateTrace(runId, (trace) => {
            trace.usage.inputTokens += event.input_token_count ?? 0;
            trace.usage.cachedTokens += event.cached_token_count ?? 0;
            trace.usage.outputTokens += event.output_token_count ?? 0;
            trace.usage.reasoningTokens += event.reasoning_token_count ?? 0;
            trace.usage.toolTokens += event.tool_token_count ?? 0;
          });
          if (state.lastModelCallSpanId) {
            this.store.updateSpan(runId, state.lastModelCallSpanId, (span) => {
              if (event.output_token_count !== undefined) {
                span.attributes.outputTokens = event.output_token_count;
              }
              if (event.reasoning_token_count !== undefined) {
                span.attributes.reasoningTokens = event.reasoning_token_count;
              }
              if (event.cached_token_count !== undefined) {
                span.attributes.cachedTokens = event.cached_token_count;
              }
              if (event.ttft_ms !== undefined) {
                span.attributes.ttftMs = event.ttft_ms;
              }
            });
          }
        } else if (event["error.message"]) {
          this.appendChild(runId, this.activeParent(state, turnSpanId), {
            name: "codex.sse_event",
            label: "Stream error (" + event["event.kind"] + ")",
            kind: "system",
            actor: "system",
            status: "error",
            startedAt: timestamp,
            endedAt: timestamp,
            durationMs: event.duration_ms ?? 0,
            attributes: { kind: event["event.kind"] },
            error: this.redactor.redactText(event["error.message"]),
          });
        }
        return;
      }
      case "codex.tool_decision": {
        const spanId = randomUUID();
        state.toolSpans.set(event.call_id, spanId);
        const subagent = isSubagentTool(event.tool_name);
        const parentId = this.activeParent(state, turnSpanId);
        this.store.appendSpan(runId, {
          id: spanId,
          traceId: runId,
          parentId,
          name: "tool." + event.tool_name,
          label: subagent
            ? "Subagent · task"
            : "Tool · " + event.tool_name,
          kind: "tool_call",
          actor: "agent",
          status: event.decision === "denied" || event.decision === "abort" ? "error" : "running",
          startedAt: timestamp,
          endedAt: null,
          durationMs: null,
          attributes: {
            toolName: event.tool_name,
            callId: event.call_id,
            decision: event.decision,
            decisionSource: event.source,
            ...(subagent ? { subagent: true } : {}),
          },
          error:
            event.decision === "denied" || event.decision === "abort"
              ? "Tool call " + event.decision
              : null,
        });
        if (subagent && event.decision !== "denied" && event.decision !== "abort") {
          state.subagentStack.push(spanId);
        }
        return;
      }
      case "codex.tool_result": {
        const callId = event.call_id ?? "";
        const existing = state.toolSpans.get(callId);
        const succeeded = event.success === "true";
        const output = event.output
          ? this.redactor.redactText(clip(event.output, OUTPUT_CLIP))
          : "";
        const toolArguments = event.arguments
          ? this.redactor.redactText(clip(event.arguments, ARGUMENT_CLIP))
          : "";
        if (existing) {
          this.store.updateSpan(
            runId,
            existing,
            (span) => {
              span.status = succeeded ? "ok" : "error";
              span.endedAt = timestamp;
              span.durationMs = event.duration_ms;
              if (toolArguments) span.attributes.arguments = toolArguments;
              if (output) span.attributes.output = output;
              if (event.mcp_server) span.attributes.mcpServer = event.mcp_server;
              span.error = succeeded ? null : clip(output, 400) || "Tool failed";
              if (isSubagentTool(event.tool_name)) {
                const subagentLabel = readSubagentLabel(toolArguments);
                if (subagentLabel) {
                  span.attributes.subagentType = subagentLabel;
                  span.label = "Subagent · " + subagentLabel;
                }
              }
            },
            { emit: true },
          );
          if (isSubagentTool(event.tool_name)) {
            this.popSubagentScope(state, existing);
          }
          if (succeeded) {
            state.toolsSinceLastModelCall.push(event.tool_name);
            if (output) state.lastToolOutput = clip(output, OUTPUT_CLIP);
          }
          if (succeeded && output) {
            this.synthesizeSubagentResultsFromOutput(
              runId,
              existing,
              timestamp,
              event.duration_ms,
              output,
            );
          }
        } else {
          this.appendChild(runId, this.activeParent(state, turnSpanId), {
            name: "tool." + event.tool_name,
            label: isSubagentTool(event.tool_name)
              ? "Subagent task"
              : "Called " + event.tool_name,
            kind: "tool_call",
            actor: "agent",
            status: succeeded ? "ok" : "error",
            startedAt: new Date(
              new Date(timestamp).getTime() - event.duration_ms,
            ).toISOString(),
            endedAt: timestamp,
            durationMs: event.duration_ms,
            attributes: {
              toolName: event.tool_name,
              callId,
              ...(isSubagentTool(event.tool_name) ? { subagent: true } : {}),
              ...(toolArguments ? { arguments: toolArguments } : {}),
              ...(output ? { output } : {}),
            },
            error: succeeded ? null : clip(output, 400) || "Tool failed",
          });
          if (succeeded) {
            state.toolsSinceLastModelCall.push(event.tool_name);
            if (output) state.lastToolOutput = clip(output, OUTPUT_CLIP);
          }
        }
        return;
      }
      case "codex.turn_ttft": {
        this.store.updateSpan(runId, turnSpanId, (span) => {
          span.attributes.ttftMs = event.duration_ms;
        });
        return;
      }
      default: {
        if ("error.message" in event && event["error.message"]) {
          this.appendChild(runId, this.activeParent(state, turnSpanId), {
            name: event["event.name"],
            label: event["event.name"],
            kind: "system",
            actor: "system",
            status: "error",
            startedAt: timestamp,
            endedAt: timestamp,
            durationMs: 0,
            attributes: {},
            error: this.redactor.redactText(event["error.message"]),
          });
        }
      }
    }
  }

  private ensureTurn(runId: string, state: RunState, timestamp: string) {
    if (state.turnSpanId) return state.turnSpanId;
    const spanId = randomUUID();
    state.turnSpanId = spanId;
    this.store.appendSpan(runId, {
      id: spanId,
      traceId: runId,
      parentId: state.rootSpanId,
      name: "codex.turn",
      label: "Codex turn",
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

  private synthesizeSubagentResultsFromOutput(
    runId: string,
    parentSpanId: string,
    endedAt: string,
    durationMs: number,
    output: string,
  ) {
    let results: ReturnType<typeof extractSimulatedSubagentResults> = [];
    try {
      results = extractSimulatedSubagentResults(output);
    } catch {
      return;
    }
    if (results.length === 0) return;

    const toolStartedAt = new Date(
      new Date(endedAt).getTime() - durationMs,
    ).toISOString();

    this.store.updateSpan(runId, parentSpanId, (span) => {
      span.attributes.spawnsSubagents = true;
      span.attributes.subagentCount = results.length;
      const toolName = span.attributes.toolName;
      if (typeof toolName === "string") {
        span.label = "Tool · " + toolName + " · spawns ×" + results.length;
      }
    });

    for (const result of results) {
      const resultEndedAt = result.timestamp
        ? new Date(result.timestamp).toISOString()
        : endedAt;
      const resultStartedAt = result.timestamp
        ? new Date(result.timestamp - 200).toISOString()
        : toolStartedAt;
      this.store.appendSpan(runId, {
        id: randomUUID(),
        traceId: runId,
        parentId: parentSpanId,
        name: "subagent.result",
        label: "Subagent · " + result.index + " · returned",
        kind: "system",
        actor: "agent",
        status: "ok",
        startedAt: resultStartedAt,
        endedAt: resultEndedAt,
        durationMs:
          new Date(resultEndedAt).getTime() - new Date(resultStartedAt).getTime(),
        attributes: {
          subagentIndex: result.index,
          result: result.payload,
          synthesized: true,
        },
        error: null,
      });
    }
  }

  private activeParent(state: RunState, turnSpanId: string) {
    return state.subagentStack[state.subagentStack.length - 1] ?? turnSpanId;
  }

  private popSubagentScope(state: RunState, spanId: string) {
    const index = state.subagentStack.indexOf(spanId);
    if (index >= 0) {
      state.subagentStack.splice(index);
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
    this.store.appendSpan(runId, {
      id: randomUUID(),
      traceId: runId,
      parentId,
      ...span,
    });
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
