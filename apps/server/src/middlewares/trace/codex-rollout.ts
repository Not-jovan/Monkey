import { glob } from "node:fs/promises";
import path from "node:path";
import type {
  NormalizedRuntimeEvent,
  RuntimeTraceAdapter,
  TimestampedEvent,
} from "./runtime-events.js";

// Reads Codex's own rollout file directly — never written by us, only
// located and parsed. Schema verified against real files this project
// generated under ~/.volc-agent-launchpad/codex-home/sessions/**/*.jsonl,
// not vendor docs alone; see __fixtures__/codex-rollout.jsonl for a
// schema-accurate example of every line shape handled below.
//
// Deliberately NOT handled, because no real session file inspected showed
// one: a distinct tool-approval-denial event, or a turn-level API-failure
// event. This project always runs Codex with an auto-approving sandbox
// policy, so decisions are synthesized as "approved"/"auto" rather than
// read. Run-level failure attribution is unaffected either way — that comes
// from the separate stdout `--json` event stream (runtimes/codex.ts's
// readStreamError), not from this file.

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestampMs(line: RolloutLine): number {
  const parsed = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

// Codex reports the outcome of a shell command as text inside the tool's own
// output ("Process exited with code N"), not as a structured field — the
// same convention trace-service.ts's EXIT_PATTERNS/readCommandFailure already
// parse for the OTLP-sourced tool_result.output today. The adapter passes
// output straight through unexamined; that existing logic keeps doing the
// same job it always did, just fed from a different source.

interface PendingCall {
  toolName: string;
  arguments: string | undefined;
  startedAtMs: number;
}

export const codexRolloutAdapter: Pick<RuntimeTraceAdapter, "locateLog" | "parseLog"> = {
  async locateLog(homeDir, conversationId) {
    const pattern = path.join(homeDir, "sessions", "**", "*-" + conversationId + ".jsonl");
    for await (const match of glob(pattern)) {
      return match;
    }
    return null;
  },

  // `flushTrailing` isn't needed here: every Codex line maps to zero or one
  // complete events entirely on its own (a function_call's decision doesn't
  // wait on its output to be reported) — nothing is ever held back for a
  // later line the way Claude Code's message-id groups are.
  parseLog(text) {
    const events: TimestampedEvent[] = [];
    const pendingCalls = new Map<string, PendingCall>();
    let lastTimestampMs = 0;
    const push = (event: NormalizedRuntimeEvent, atMs: number) => {
      events.push({ event, timestamp: new Date(atMs || Date.now()).toISOString() });
    };

    for (const rawLine of text.split("\n")) {
      if (rawLine.length === 0) continue;
      let line: RolloutLine;
      try {
        line = JSON.parse(rawLine) as RolloutLine;
      } catch {
        continue;
      }
      const payload = line.payload;
      if (!isRecord(payload)) continue;
      const at = timestampMs(line);
      if (at > 0) lastTimestampMs = at;

      if (line.type === "turn_context") {
        push(
          {
            kind: "conversation_started",
            model: typeof payload.model === "string" ? payload.model : undefined,
            approvalPolicy:
              typeof payload.approval_policy === "string" ? payload.approval_policy : undefined,
            sandboxPolicy: isRecord(payload.sandbox_policy)
              ? String(payload.sandbox_policy.type ?? "")
              : undefined,
          },
          at,
        );
        continue;
      }

      if (line.type !== "event_msg" && line.type !== "response_item") continue;
      const kind = payload.type;

      if (line.type === "event_msg" && kind === "user_message") {
        const message = typeof payload.message === "string" ? payload.message : "";
        push({ kind: "user_prompt", promptLength: message.length, prompt: message }, at);
        continue;
      }

      if (line.type === "event_msg" && kind === "token_count") {
        const info = payload.info;
        const usage = isRecord(info) ? info.last_token_usage : undefined;
        if (!isRecord(usage)) continue;
        const durationMs = Math.max(0, at - lastTimestampMs);
        push(
          {
            kind: "model_call",
            spanName: "codex.model_call",
            durationMs,
            failed: false,
            usage: {
              inputTokens:
                typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
              cachedTokens:
                typeof usage.cached_input_tokens === "number"
                  ? usage.cached_input_tokens
                  : undefined,
              outputTokens:
                typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
              reasoningTokens:
                typeof usage.reasoning_output_tokens === "number"
                  ? usage.reasoning_output_tokens
                  : undefined,
            },
          },
          at,
        );
        continue;
      }

      if (line.type === "response_item" && kind === "function_call") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : "";
        const toolName = typeof payload.name === "string" ? payload.name : "unknown_tool";
        const argumentsJson =
          typeof payload.arguments === "string" ? payload.arguments : undefined;
        if (callId.length === 0) continue;
        pendingCalls.set(callId, { toolName, arguments: argumentsJson, startedAtMs: at });
        push(
          {
            kind: "tool_decision",
            toolName,
            callId,
            decision: "approved",
            rawDecision: "auto",
            source: "auto",
          },
          at,
        );
        continue;
      }

      if (line.type === "response_item" && kind === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : "";
        const pending = pendingCalls.get(callId);
        const output = typeof payload.output === "string" ? payload.output : undefined;
        push(
          {
            kind: "tool_result",
            toolName: pending?.toolName ?? "unknown_tool",
            callId,
            arguments: pending?.arguments,
            durationMs: pending ? Math.max(0, at - pending.startedAtMs) : 0,
            // Codex reports the harness call itself as successful whenever
            // the command actually ran, even a non-zero exit — the same
            // convention readCommandFailure already expects to see and
            // correct for.
            success: true,
            output,
          },
          at,
        );
        pendingCalls.delete(callId);
        continue;
      }
    }
    return events;
  },
};
