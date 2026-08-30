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

// Where an upstream completion died, when it did. Null abortPhase means the
// call finished; the timings are still recorded so a slow success is
// comparable to a timeout.
export type ProviderAbortPhase =
  | "waiting_for_headers"
  | "waiting_for_first_token"
  | "streaming";

export interface ProviderCallTiming {
  promptBytes: number;
  inFlightAtStart: number;
  headersMs: number | null;
  ttftMs: number | null;
  lastChunkMs: number | null;
  chunkCount: number;
  requestId: string | null;
  abortPhase: ProviderAbortPhase | null;
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
  // Present for in-process Ark completions. Process runtimes have no HTTP
  // phases of their own, so they leave this unset.
  timing?: ProviderCallTiming | undefined;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  // A CLI runtime resolves its own model and system prompt from its config and
  // the workspace; an in-process runner has to be told both. Optional so the
  // process runners, which have no use for either, are unaffected.
  system?: string | undefined;
  model?: string | undefined;
  // A provider-side cache already holding `system` and the leading, shared
  // part of `prompt`. When it hits, only `tail` is sent. `prompt` and `system`
  // stay populated regardless: they are what the provider client falls back to
  // if the cache turns out to be gone. Only an in-process runner talking to a
  // caching provider reads this — a CLI runtime owns its own cache and ignores
  // it, which is why it is optional.
  promptCache?: { contextId: string; tail: string } | undefined;
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

// Opening a cache for a prompt several calls are about to share. Separate from
// AgentRunner because most runners have nothing to open: a CLI runtime already
// caches on its own, and only a caller that knows two of its calls share a
// prefix can say where the cache should start.
export interface PromptCache {
  // Null rather than a throw, and null rather than an error: a cache that
  // could not be opened costs tokens, never a verdict, so no caller should
  // have to handle it as a failure.
  open(input: {
    model: string;
    system: string;
    prefix: string;
  }): Promise<string | null>;
}
