import type { SystemInfo } from "./types";

// One place for the runtime's display name. It had grown into four separate
// inline ternaries across App.tsx, which is how the chat status line ended up
// still saying "Codex" after the rest had been made runtime-aware.
export function runtimeDisplayName(
  agentRuntime: SystemInfo["agentRuntime"] | undefined,
): string {
  return agentRuntime === "claude-code" ? "Claude Code" : "Codex";
}

// The CLI's full name, for prose that refers to the installable tool rather
// than to the running Agent ("Codex CLI was not found").
export function runtimeCliName(
  agentRuntime: SystemInfo["agentRuntime"] | undefined,
): string {
  return agentRuntime === "claude-code" ? "Claude Code" : "Codex CLI";
}

// What the sidebar shows under the runtime name when no model is known yet.
// Claude Code resolves its model from the account on the first run, so before
// then there is genuinely nothing to report — say so rather than showing the
// Ark model, which that runtime never calls.
export function modelPlaceholder(
  agentRuntime: SystemInfo["agentRuntime"] | undefined,
): string {
  return agentRuntime === "claude-code"
    ? "model resolved at run time"
    : "Ark model not configured";
}
