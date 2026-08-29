import type { RunFailure } from "./failures.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  // The attributed form of `error`. Kept alongside rather than replacing it, so
  // anything already reading the string keeps working.
  failure: RunFailure | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  // Null when the runtime never reported one (Codex, whose model comes from
  // config and the OTLP trace instead).
  model: string | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  // Names the failure transcript written when a run fails. Optional so tests
  // and any caller that does not need post-mortem logs can omit it.
  runId?: string | undefined;
  // Applied to the transcript before it touches disk, so a debug artifact
  // never becomes the one place a credential survives unmasked.
  redact?: ((text: string) => string) | undefined;
  // Fires as soon as the runtime names the model it is running on, which is
  // before the turn does any work. Reported this way rather than on
  // RunnerResult because a run that fails never returns one, and a failed run
  // is exactly when knowing the model matters.
  onModel?: ((model: string) => void) | undefined;
  // Fires as soon as the runtime names the conversation this run belongs to
  // (Codex's thread id, Claude Code's session id). The trace pipeline binds
  // its OTLP records on that id, so until this fires every record a runtime
  // exports is buffered unattached. Reported here rather than read off
  // onEvent because the announcing event is runtime-shaped, and only the
  // runtime's own parser knows it.
  onThread?: ((threadId: string) => void) | undefined;
  // Streams every parsed runtime JSONL event to the caller while the run is
  // still in flight.
  onEvent?: ((event: Record<string, unknown>) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
