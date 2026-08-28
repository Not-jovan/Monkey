export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export type SpanKind =
  | "run"
  | "user_action"
  | "turn"
  | "model_call"
  | "tool_call"
  | "system";
export type SpanStatus = "running" | "ok" | "error";
export type TraceStatus = "running" | "completed" | "failed" | "cancelled";

export interface TraceSpan {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  label: string;
  kind: SpanKind;
  actor: "user" | "agent" | "system";
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
  warningCount: number;
}

export interface TraceRecord {
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

export interface AuditTraceStep {
  id: string;
  traceId: string;
  agentId: string;
  spanId: string | null;
  type: "warning" | "error";
  category: "intent-check" | "security";
  finding: string;
}

export interface IntentState {
  objective: string;
  extended: string[];
}

export interface IntentVersion {
  objective: string;
  extended: string[];
  update?: { logs: string[] };
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
