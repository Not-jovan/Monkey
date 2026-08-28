import type { AppConfig } from "../config.js";
import { claudeCodeRuntime } from "./claude-code.js";
import { codexRuntime } from "./codex.js";
import type { RuntimeDefinition } from "./types.js";

export function selectRuntime(config: AppConfig): RuntimeDefinition {
  return config.agentRuntime === "claude-code" ? claudeCodeRuntime : codexRuntime;
}

export type { RuntimeDefinition } from "./types.js";
