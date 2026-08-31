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

// Mirrors apps/server/src/failures.ts. Only "agent" and "task" mean the agent
// is what needs improving; the rest are the platform, the provider, a policy
// boundary, or the operator.
export type FailureLayer =
  | "platform"
  | "provider"
  | "policy"
  | "agent"
  | "task"
  | "user";

export type Retryability = "transient" | "permanent" | "user-action";

export interface RunFailure {
  layer: FailureLayer;
  kind: string;
  retryability: Retryability;
  title: string;
  detail: string;
  remedy: string;
  exitCode: number | null;
}

export type AuditHealth = "ok" | "degraded" | "failed";

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  failure: RunFailure | null;
  // Recovered-error counts live on the trace, not here: two copies of the same
  // number could disagree, and this one was never read.
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

export interface AuditAttempt {
  id: string;
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
}

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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RuntimeEventRecord {
  at: string;
  event: { [key: string]: JsonValue };
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
  failure: RunFailure | null;
  recoveredErrorCount: number;
  evidenceComplete: boolean;
  warningCount: number;
  // Questions the auditor raised and could not settle. Kept out of
  // warningCount so the row does not claim more than the auditor concluded.
  suspicionCount: number;
  auditHealth: AuditHealth;
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
  failure: RunFailure | null;
  recoveredErrorCount: number;
  evidenceComplete: boolean;
  evidenceProblem: string | null;
  unrecognizedEvents: number;
  // Set when this run is an audit of another trace, and how many audits deep
  // that makes it. An agent's own run is depth 0 with no target.
  auditOf: string | null;
  auditDepth: number;
  runtimeEvents: RuntimeEventRecord[];
  spans: TraceSpan[];
}

export interface RunDigest {
  prompt: string;
  outcome: string;
  filesTouched: string[];
  commands: string[];
  services: string[];
  failureKind: string | null;
  failureLayer: string | null;
}

export interface RunContext {
  traceId: string;
  agentId: string;
  conversationId: string | null;
  startedAt: string;
  endedAt: string;
  intentId: string;
  summary: string;
  // "derived" means no model was involved. Shown, because a reader should know
  // which kind of summary they are looking at.
  source: "derived" | "model";
  digest: RunDigest;
}

export interface ContextView {
  carriedIn: RunContext | null;
  carriedOut: RunContext | null;
  position: number;
  chainLength: number;
  previousTraceId: string | null;
  nextTraceId: string | null;
}

export interface AuditorTrace {
  // The run that was judged. The auditor's work is `auditor`, whose id is
  // `auditTraceId` — not this one.
  auditedTraceId: string;
  agentId: string;
  health: AuditHealth;
  auditTraceId: string | null;
  auditor: TraceRecord | null;
  // Every auditor pass over this run, newest first. `auditor` is the latest.
  auditAttempts: AuditAttempt[];
  legacyAuditorSpans: TraceSpan[];
  // An audit of the auditor recorded before that run had a trace of its own.
  // Read-only: nothing writes here any more, but a finding already recorded
  // should not vanish because the shape around it changed.
  legacyMetaAudit: AuditTraceStep[];
  legacyMetaAuditedAt: string | null;
}

export interface AuditTraceStep {
  id: string;
  traceId: string;
  agentId: string;
  spanId: string | null;
  // The spec version this finding was judged against. Empty for findings about
  // the auditor itself, and for audits written before findings carried it.
  intentId: string;
  // A suspicion is something the auditor could see but not decide on its own —
  // an action that *might* have deviated, an instruction that *might* have been
  // obeyed. It is deliberately weaker than a warning and is rendered as such.
  type: "warning" | "suspicion" | "error";
  // "audit-health" is the auditor reporting on itself, never a claim about the
  // agent. Kept out of warning counts for that reason.
  category: "intent-check" | "security" | "reliability" | "audit-health";
  finding: string;
}

export interface IntentState {
  // What the agent was told to do, mirrored from its settings. The agent reads
  // this from its workspace, so it is the source of truth for the objective.
  instructions: string;
  objective: string;
  extended: string[];
}

// The kinds of edit a derivation can record. History is the sequence of
// per-audit identifier passes, not a standing store someone can rewind.
export type IntentUpdateKind = "seed" | "classified";
// The spec a trace was judged against, stored on that chat audit.
export type TraceIntentView = IntentState;

export interface IntentUpdate {
  logs: string[];
  kind: IntentUpdateKind;
  message?: string;
  reason?: string;
  addedConstraints: string[];
  removedConstraints: string[];
  previousObjective: string | null;
  // The run whose message moved the spec, so the Playground can mark it.
  traceId: string | null;
  revertedFrom: string | null;
  sourceFindingId?: string | null;
  sourceSpanId?: string | null;
}

export interface IntentVersion {
  instructions: string;
  objective: string;
  extended: string[];
  createdAt?: string;
  update?: IntentUpdate;
}

// History is append-only, so position in the ordered list is the version number
// a reader sees.
export interface IntentVersionEntry extends IntentVersion {
  id: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  agentRuntime: "codex" | "claude-code";
  // The model the Agent runtime itself runs on. Null until a Claude Code run
  // has reported one; for Codex this is the configured Ark model.
  agentModel: string | null;
  runtimeAvailable: boolean;
  codexSandboxMode: string;
  mockDisruptTracer: boolean;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

// An operator's answer to what an audit found: a constraint added to the
// Agent's spec, and the evidence they were reading when they added it. The
// spec itself is the Agent's instructions — this is the record of the change,
// which is also what makes it undoable.
export interface IntentCorrection {
  id: string;
  agentId: string;
  traceId: string;
  findingIds: string[];
  correction: string;
  instructionsBefore: string;
  createdAt: string;
  revertedAt: string | null;
}
