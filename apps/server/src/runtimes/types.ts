import type { AppConfig } from "../config.js";
import type { RuntimeTraceAdapter } from "../traces/runtime-events.js";
import type { RunUsage, RunnerRequest } from "../types.js";

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  // The model the runtime reported for this session. Only runtimes that
  // resolve their model at run time need to fill this in — Codex leaves it
  // null because its model is known from config and from OTLP.
  model: string | null;
}

// Everything that differs between Agent runtimes (Codex, Claude Code, ...).
// A single generic ProcessRuntimeRunner/ContainerRuntimeRunner is driven by
// one of these; adding a runtime means adding a RuntimeDefinition, not a
// class.
export interface RuntimeDefinition {
  id: "codex" | "claude-code";
  bin(config: AppConfig): string;
  homeDir(config: AppConfig): string;
  // Env var this runtime uses to relocate its config/session home directory
  // ("CODEX_HOME" | "CLAUDE_CONFIG_DIR").
  homeEnvVar: string;

  buildArgs(
    request: RunnerRequest,
    workspacePath: string,
    config: AppConfig,
  ): string[];

  // Parses one line of the runtime's stdout event stream. Distinct from the
  // OTLP trace pipeline — this is how the caller gets the reply text,
  // resumable thread/session id, and usage back into RunnerResult.
  parseEventLine(
    line: string,
    parsed: ParsedEvents,
    onEvent?: (event: Record<string, unknown>) => void,
  ): void;

  // One-time side effects at boot (Codex: writes config.toml into homeDir;
  // Claude Code: no-op, it's configured entirely through env vars).
  bootstrap(config: AppConfig, collectorToken: string): Promise<void>;

  // All env vars this runtime's process needs beyond PATH/HOME passthrough:
  // provider credential, home-dir var (host path — callers that need the
  // container path override homeEnvVar themselves), OTLP telemetry vars.
  // Computed fresh per run; used both as local child-process env and as the
  // source for container --env flags, so neither runner implementation
  // needs runtime-specific knowledge of what env vars matter.
  processEnv(config: AppConfig, collectorToken: string): NodeJS.ProcessEnv;

  trace: RuntimeTraceAdapter;
}
