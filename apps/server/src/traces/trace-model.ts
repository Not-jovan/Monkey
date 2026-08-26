export type SpanKind =
  | "run"
  | "user_action"
  | "turn"
  | "model_call"
  | "tool_call"
  | "system";
export type SpanStatus = "running" | "ok" | "error";
export type SpanActor = "user" | "agent" | "system";
export type TraceStatus = "running" | "completed" | "failed" | "cancelled";

export interface TraceSpan {
  id: string;
  traceId: string;
  parentId: string | null;
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
}

export interface TraceUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolTokens: number;
}

export interface TraceRecord {
  version: 1;
  // Trace id doubles as the run id: one Playground message is one run is one
  // trace document.
  id: string;
  agentId: string;
  conversationId: string | null;
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  model: string | null;
  usage: TraceUsage;
  failingSpanId: string | null;
  unrecognizedEvents: number;
  spans: TraceSpan[];
}

export interface TraceSummary {
  id: string;
  agentId: string;
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  model: string | null;
  usage: TraceUsage;
  spanCount: number;
  errorCount: number;
  failingSpanId: string | null;
}

export type AgentLifecycleType =
  | "created"
  | "updated"
  | "deleted"
  | "started"
  | "stopped";

export interface AgentLifecycleEvent {
  id: string;
  agentId: string;
  type: AgentLifecycleType;
  at: string;
  details: string;
}

export const emptyUsage = (): TraceUsage => ({
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolTokens: 0,
});

export function summarizeTrace(trace: TraceRecord): TraceSummary {
  return {
    id: trace.id,
    agentId: trace.agentId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    prompt: trace.prompt,
    model: trace.model,
    usage: trace.usage,
    spanCount: trace.spans.length,
    errorCount: trace.spans.filter((span) => span.status === "error").length,
    failingSpanId: trace.failingSpanId,
  };
}
