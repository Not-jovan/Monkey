// The vocabulary TraceService.applyRecord switches on. Each Agent runtime's
// RuntimeTraceAdapter maps its own raw session-log shape onto these kinds; a
// runtime that has no analog for a kind (or a raw event with no
// representation here) simply never emits it — applyRecord's case for it
// then never fires for that runtime rather than requiring every runtime to
// emit every kind.
//
// Optional fields are typed `T | undefined` rather than bare `T` because
// this project builds with exactOptionalPropertyTypes — the adapters below
// build these objects from zod-optional fields, which are `T | undefined`,
// not omittable keys.

export interface UsageFields {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  toolTokens: number;
  ttftMs: number;
}

// Not Partial<UsageFields> — with exactOptionalPropertyTypes, Partial<T>
// produces `key?: T`, which rejects an explicit `undefined` value; the
// adapters below pass zod-optional fields through as `T | undefined`.
export type PartialUsage = { [K in keyof UsageFields]?: UsageFields[K] | undefined };

export type NormalizedRuntimeEvent =
  | {
      kind: "conversation_started";
      model?: string | undefined;
      provider?: string | undefined;
      approvalPolicy?: string | undefined;
      sandboxPolicy?: string | undefined;
      mcpServers?: string[] | undefined;
    }
  | {
      kind: "user_prompt";
      promptLength: number;
      prompt?: string | undefined;
    }
  | {
      kind: "model_call";
      // The span's `name` field. Each runtime supplies its own literal
      // (e.g. "codex.api_request") rather than applyRecord hardcoding one,
      // so existing per-runtime span-name assertions (tests, UI) keep
      // working unchanged across this normalization.
      spanName: string;
      durationMs: number;
      failed: boolean;
      statusCode?: number | undefined;
      attempt?: number | undefined;
      errorMessage?: string | undefined;
      // Present when the runtime reports usage in the same record as the
      // call itself (Claude Code); absent when it arrives later via a
      // separate "model_call_usage" event (Codex).
      usage?: PartialUsage | undefined;
    }
  | {
      kind: "model_call_usage";
      usage: PartialUsage;
    }
  | {
      kind: "stream_error";
      spanName: string;
      errorMessage: string;
      durationMs?: number | undefined;
      label?: string | undefined;
      // Raw sub-kind of the underlying stream event (e.g. "response.failed"),
      // kept as a span attribute the way Codex's did.
      attributeKind?: string | undefined;
    }
  | {
      kind: "tool_decision";
      toolName: string;
      callId: string;
      // Collapsed to a binary outcome so downstream logic doesn't need a
      // runtime-specific enum; the original string is kept for display.
      decision: "approved" | "denied";
      rawDecision: string;
      source: string;
    }
  | {
      kind: "tool_result";
      toolName: string;
      callId?: string | undefined;
      arguments?: string | undefined;
      durationMs: number;
      success: boolean;
      output?: string | undefined;
      mcpServer?: string | undefined;
    }
  | {
      kind: "turn_ttft";
      durationMs: number;
    }
  // A raw event this runtime recognizes but has no specific handling for.
  // Distinct from "unrecognized" (schema didn't even parse): applyRecord
  // silently drops these rather than counting them as unrecognized.
  | { kind: "ignored" }
  // Same as "ignored", except the raw event carried an error message worth
  // surfacing as a system-error span even though nothing else about it is
  // understood.
  | {
      kind: "generic_error";
      eventName: string;
      errorMessage: string;
    };

// A NormalizedRuntimeEvent paired with when it happened. Every raw line a
// runtime writes carries its own timestamp; applyRecord needs one per event
// for span startedAt/endedAt/duration, the same way it always has.
export interface TimestampedEvent {
  event: NormalizedRuntimeEvent;
  timestamp: string;
}

export interface RuntimeTraceAdapter {
  // Mirrors RuntimeDefinition.id. TraceService is handed the adapter rather
  // than the whole definition, and it needs the runtime's identity for the
  // spans it names itself (the turn span) — a Claude Code run was rendering
  // a "Codex turn" on its trace page. Kept in sync by an assertion in
  // runtimes/index.test.ts rather than by hope.
  runtimeId: "codex" | "claude-code";
  // How the runtime is written in span labels a human reads.
  displayName: string;
  // Finds the session log this runtime already writes for a given
  // conversation id, under the runtime's own home directory — no code of
  // ours ever creates or names this file, we only locate it. Returns null
  // when it doesn't exist yet: a run whose CLI process hasn't created (or
  // flushed) it yet, not an error.
  locateLog(homeDir: string, conversationId: string): Promise<string | null>;
  // Parses the log's full text into the complete, ordered sequence of
  // events it represents so far — always from the start, not incrementally.
  // Re-parsing the whole (small, plain-text) file on every poll tick is
  // deliberately simple: it sidesteps needing any state to survive between
  // calls (no pending-tool-call map to lose track of across ticks), at the
  // cost of repeated cheap work this project's scale doesn't need to avoid.
  //
  // The caller — TraceService — tracks how many of the returned events have
  // already been applied and only applies the tail past that count; the
  // *event* index is the durable cursor, not a byte or line offset.
  //
  // `flushTrailing` is true exactly when the caller already knows no further
  // lines will ever be appended (the run has reached a terminal state), so a
  // still-accumulating group at the end of the file (Claude Code splits one
  // logical step across several lines sharing a message id) should be
  // treated as complete rather than held back for a tick that will never
  // come.
  parseLog(text: string, flushTrailing: boolean): TimestampedEvent[];
}
