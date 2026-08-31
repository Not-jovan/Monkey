import { glob } from "node:fs/promises";
import path from "node:path";
import type {
  RuntimeTraceAdapter,
  TimestampedEvent,
} from "./runtime-events.js";

// Reads Claude Code's own session transcript directly — never written by
// us, only located and parsed. Schema verified against real files this
// project generated under
// ~/.volc-agent-launchpad/claude-home/projects/**/*.jsonl, not vendor docs
// alone; see __fixtures__/claude-code-session.jsonl for a schema-accurate
// example, including the quirk this parser exists to handle: one logical
// model turn is split across up to three separate lines (thinking, text,
// tool_use) that all share the same `message.id` — grouped here into one
// model_call event instead of three, since `uuid` differs per line but
// `message.id` doesn't.
//
// Unverified against a real example: subagent/Task nesting (`isSidechain`
// looks like the marker, but no real session file inspected exercised it) —
// falls through to a flat span rather than nested, same as an unrecognized
// event would.
//
// Also not carried over: the OTLP adapter filtered out a background
// session-title-naming model call (BACKGROUND_QUERY_SOURCES in the old
// claude-code.ts) that arrived first and skewed the run's usage/labels. No
// real session file inspected showed an equivalent "query_source" marker on
// its assistant entries to filter the same way here — if it resurfaces as a
// visible extra span, that is the same intentionally-visible failure mode
// the original denylist comment described, not silent data loss.

interface SessionLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  message?: Record<string, unknown>;
  toolUseResult?: Record<string, unknown>;
  error?: string;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestampMs(line: SessionLine): number {
  const parsed = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

interface PendingToolUse {
  toolName: string;
  arguments: string;
  startedAtMs: number;
}

// One assistant turn's content is spread across several SessionLines that
// all share message.id — accumulated here, then turned into a single
// model_call plus one tool_decision per tool_use block once the group is
// known complete.
interface AssistantGroup {
  messageId: string;
  model: string | undefined;
  firstAtMs: number;
  lastAtMs: number;
  usage: Record<string, unknown> | undefined;
  toolUses: { id: string; name: string; input: unknown }[];
  failed: boolean;
  errorMessage: string | undefined;
  statusCode: number | undefined;
}

function flushGroup(group: AssistantGroup, pendingCalls: Map<string, PendingToolUse>) {
  const events: TimestampedEvent[] = [];
  const usage = group.usage ?? {};
  const timestamp = new Date(group.lastAtMs || Date.now()).toISOString();
  events.push({
    event: {
      kind: "model_call",
      spanName: "claude_code.model_call",
      durationMs: Math.max(0, group.lastAtMs - group.firstAtMs),
      failed: group.failed,
      errorMessage: group.errorMessage,
      statusCode: group.statusCode,
      usage: {
        inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
        outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
        cachedTokens:
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : undefined,
      },
    },
    timestamp,
  });
  for (const toolUse of group.toolUses) {
    const argumentsJson = JSON.stringify(toolUse.input ?? {});
    pendingCalls.set(toolUse.id, {
      toolName: toolUse.name,
      arguments: argumentsJson,
      startedAtMs: group.lastAtMs,
    });
    events.push({
      event: {
        kind: "tool_decision",
        toolName: toolUse.name,
        callId: toolUse.id,
        decision: "approved",
        rawDecision: "auto",
        source: "auto",
      },
      timestamp,
    });
  }
  return events;
}

export const claudeCodeSessionAdapter: Pick<RuntimeTraceAdapter, "locateLog" | "parseLog"> = {
  async locateLog(homeDir, conversationId) {
    const pattern = path.join(homeDir, "projects", "**", conversationId + ".jsonl");
    for await (const match of glob(pattern)) {
      return match;
    }
    return null;
  },

  parseLog(text, flushTrailing) {
    const events: TimestampedEvent[] = [];
    const pendingCalls = new Map<string, PendingToolUse>();
    let group: AssistantGroup | null = null;

    const closeGroup = () => {
      if (!group) return;
      events.push(...flushGroup(group, pendingCalls));
      group = null;
    };

    const lines = text.split("\n").filter((line) => line.length > 0);
    for (let index = 0; index < lines.length; index += 1) {
      let line: SessionLine;
      try {
        line = JSON.parse(lines[index]!) as SessionLine;
      } catch {
        continue;
      }
      const at = timestampMs(line);
      const message = line.message;

      if (line.type === "assistant" && isRecord(message)) {
        const messageId = typeof message.id === "string" ? message.id : "";
        if (messageId.length === 0) continue;
        if (!group || group.messageId !== messageId) {
          closeGroup();
          group = {
            messageId,
            model: typeof message.model === "string" ? message.model : undefined,
            firstAtMs: at,
            lastAtMs: at,
            usage: isRecord(message.usage) ? message.usage : undefined,
            toolUses: [],
            failed: false,
            errorMessage: undefined,
            statusCode: undefined,
          };
        }
        group.lastAtMs = at;
        if (isRecord(message.usage)) group.usage = message.usage;
        if (line.isApiErrorMessage === true || typeof line.error === "string") {
          group.failed = true;
          group.statusCode = line.apiErrorStatus;
          const content = Array.isArray(message.content) ? message.content : [];
          const firstText = content.find(
            (block) => isRecord(block) && block.type === "text",
          ) as Record<string, unknown> | undefined;
          group.errorMessage =
            (typeof firstText?.text === "string" ? firstText.text : undefined) ?? line.error;
        }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!isRecord(block) || block.type !== "tool_use") continue;
          const id = typeof block.id === "string" ? block.id : "";
          const name = typeof block.name === "string" ? block.name : "unknown_tool";
          if (id.length === 0) continue;
          group.toolUses.push({ id, name, input: block.input });
        }
        continue;
      }

      // Any non-assistant line ends whatever group was accumulating — the
      // turn it belonged to is over.
      closeGroup();

      if (line.type === "user" && isRecord(message)) {
        const timestamp = new Date(at || Date.now()).toISOString();
        if (typeof message.content === "string") {
          events.push({
            event: {
              kind: "user_prompt",
              promptLength: message.content.length,
              prompt: message.content,
            },
            timestamp,
          });
          continue;
        }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!isRecord(block) || block.type !== "tool_result") continue;
          const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          const pending = pendingCalls.get(callId);
          const toolResult = line.toolUseResult;
          const output =
            typeof toolResult?.stdout === "string" && toolResult.stdout.length > 0
              ? toolResult.stdout
              : typeof block.content === "string"
                ? block.content
                : undefined;
          events.push({
            event: {
              kind: "tool_result",
              toolName: pending?.toolName ?? "unknown_tool",
              callId,
              arguments: pending?.arguments,
              durationMs: pending ? Math.max(0, at - pending.startedAtMs) : 0,
              success: block.is_error !== true && toolResult?.interrupted !== true,
              output,
            },
            timestamp,
          });
          pendingCalls.delete(callId);
        }
      }
    }

    // A group still open at end-of-file is either genuinely finished (the
    // run ended right after it, and flushTrailing says so) or might still
    // gain another content-block line on the next poll tick — held back
    // rather than guessed at.
    if (group && flushTrailing) {
      closeGroup();
    }

    return events;
  },
};
