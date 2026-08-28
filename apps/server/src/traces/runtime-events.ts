// The vocabulary TraceService.applyRecord switches on. Each Agent runtime's
// RuntimeDefinition.trace.normalize maps its own raw OTLP event shape onto
// these kinds; a runtime that has no analog for a kind (or a raw event with
// no representation here) simply never emits it — applyRecord's case for
// it then never fires for that runtime rather than requiring every runtime
// to emit every kind.
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

export interface RuntimeTraceAdapter {
  // The OTLP attribute key that correlates records to a run/conversation —
  // "conversation.id" for Codex, "session.id" for Claude Code.
  correlationAttribute: string;
  // Returns null when the attributes don't parse as a recognized event from
  // this runtime at all (TraceService counts these as unrecognizedEvents).
  normalize(attributes: Record<string, unknown>): NormalizedRuntimeEvent | null;
}
