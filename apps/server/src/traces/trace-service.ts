import { randomUUID } from "node:crypto";
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
}

interface RunState {
  agentId: string;
  rootSpanId: string;
  promptSpanId: string;
  turnSpanId: string | null;
  toolSpans: Map<string, string>;
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
      turnSpanId: null,
      toolSpans: new Map(),
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
    }
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
        this.appendChild(runId, turnSpanId, {
          name: "codex.api_request",
          label:
            "Model call" +
            (event.attempt !== undefined && event.attempt > 0
              ? " (retry " + event.attempt + ")"
              : ""),
          kind: "model_call",
          actor: "agent",
          status: failedRequest ? "error" : "ok",
          startedAt: new Date(new Date(timestamp).getTime() - duration).toISOString(),
          endedAt: timestamp,
          durationMs: duration,
          attributes: {
            ...(event["http.response.status_code"] !== undefined
              ? { statusCode: event["http.response.status_code"] }
              : {}),
            ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
          },
          error: event["error.message"]
            ? this.redactor.redactText(event["error.message"])
            : null,
        });
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
        } else if (event["error.message"]) {
          this.appendChild(runId, turnSpanId, {
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
        this.store.appendSpan(runId, {
          id: spanId,
          traceId: runId,
          parentId: turnSpanId,
          name: "tool." + event.tool_name,
          label: "Called " + event.tool_name,
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
          },
          error:
            event.decision === "denied" || event.decision === "abort"
              ? "Tool call " + event.decision
              : null,
        });
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
            },
            { emit: true },
          );
        } else {
          this.appendChild(runId, turnSpanId, {
            name: "tool." + event.tool_name,
            label: "Called " + event.tool_name,
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
              ...(toolArguments ? { arguments: toolArguments } : {}),
              ...(output ? { output } : {}),
            },
            error: succeeded ? null : clip(output, 400) || "Tool failed",
          });
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
          this.appendChild(runId, turnSpanId, {
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
