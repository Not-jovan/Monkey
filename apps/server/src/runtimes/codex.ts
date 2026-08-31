import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { parseCodexEvent } from "../middlewares/trace/codex-events.js";
import type { NormalizedRuntimeEvent } from "../middlewares/trace/runtime-events.js";
import type { RunnerRequest } from "../types.js";
import type { ParsedEvents, RuntimeDefinition } from "./types.js";

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onEvent?: (event: Record<string, unknown>) => void,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  onEvent?.(event);

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  const streamError = readStreamError(event);
  if (streamError !== null) {
    parsed.errors.push(streamError);
  }
}

// One definition of "this event reports a failure", shared by the runner and
// the trace service. They used to disagree — only the trace side counted
// `turn.failed` — so the same run could report two different error counts and
// the evidence could miss the event that said what actually went wrong.
export function readStreamError(
  event: Record<string, unknown>,
): string | null {
  if (event.type === "error") {
    if (typeof event.message === "string" && event.message.length > 0) {
      return event.message;
    }
    if (typeof event.error === "string" && event.error.length > 0) {
      return event.error;
    }
    return "Codex reported an unknown error";
  }
  if (event.type === "turn.failed") {
    const detail = event.error;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (detail !== null && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return "The Codex turn failed";
  }
  return null;
}

function isCodexTerminalEvent(event: Record<string, unknown>): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.cancelled"
  );
}

function normalizeCodexEvent(
  attributes: Record<string, unknown>,
): NormalizedRuntimeEvent | null {
  const parsed = parseCodexEvent(attributes);
  if (!parsed) return null;
  const { event, common } = parsed;

  switch (event["event.name"]) {
    case "codex.conversation_starts": {
      return {
        kind: "conversation_started",
        model: common.model,
        provider: event.provider_name,
        approvalPolicy: event.approval_policy,
        sandboxPolicy: event.sandbox_policy,
        mcpServers: event.mcp_servers.length > 0 ? event.mcp_servers : undefined,
      };
    }
    case "codex.user_prompt": {
      return {
        kind: "user_prompt",
        promptLength: event.prompt_length,
        prompt: event.prompt,
      };
    }
    case "codex.api_request": {
      const durationMs = event.duration_ms ?? 0;
      const failed =
        event["error.message"] !== undefined ||
        (event["http.response.status_code"] ?? 200) >= 400;
      return {
        kind: "model_call",
        spanName: "codex.api_request",
        durationMs,
        failed,
        statusCode: event["http.response.status_code"],
        attempt: event.attempt,
        errorMessage: event["error.message"],
      };
    }
    case "codex.sse_event": {
      if (event["event.kind"] === "response.completed") {
        return {
          kind: "model_call_usage",
          usage: {
            inputTokens: event.input_token_count,
            outputTokens: event.output_token_count,
            cachedTokens: event.cached_token_count,
            reasoningTokens: event.reasoning_token_count,
            toolTokens: event.tool_token_count,
            ttftMs: event.ttft_ms,
          },
        };
      }
      if (event["error.message"]) {
        return {
          kind: "stream_error",
          spanName: "codex.sse_event",
          errorMessage: event["error.message"],
          durationMs: event.duration_ms,
          label: "Stream error (" + event["event.kind"] + ")",
          attributeKind: event["event.kind"],
        };
      }
      return { kind: "ignored" };
    }
    case "codex.tool_decision": {
      const denied = event.decision === "denied" || event.decision === "abort";
      return {
        kind: "tool_decision",
        toolName: event.tool_name,
        callId: event.call_id,
        decision: denied ? "denied" : "approved",
        rawDecision: event.decision,
        source: event.source,
      };
    }
    case "codex.tool_result": {
      return {
        kind: "tool_result",
        toolName: event.tool_name,
        callId: event.call_id,
        arguments: event.arguments,
        durationMs: event.duration_ms,
        success: event.success === "true",
        output: event.output,
        mcpServer: event.mcp_server,
      };
    }
    case "codex.turn_ttft": {
      return { kind: "turn_ttft", durationMs: event.duration_ms };
    }
    default: {
      if ("error.message" in event && event["error.message"]) {
        return {
          kind: "generic_error",
          eventName: event["event.name"],
          errorMessage: event["error.message"],
        };
      }
      return { kind: "ignored" };
    }
  }
}

export const codexRuntime: RuntimeDefinition = {
  id: "codex",
  bin: (config) => config.codexBin,
  homeDir: (config) => config.codexHome,
  homeEnvVar: "CODEX_HOME",

  buildArgs: (request, workspacePath, config) =>
    buildCodexArgs(request, config.codexSandboxMode, workspacePath),

  parseEventLine: parseCodexEventLine,

  async bootstrap(config) {
    await mkdir(config.codexHome, { recursive: true });
    const toml = [
      "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
      "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
      'model_provider = "volcengine_ark"',
      "",
      "[model_providers.volcengine_ark]",
      'name = "Volcengine Ark"',
      "base_url = " + JSON.stringify(config.arkBaseUrl),
      'env_key = "ARK_API_KEY"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "",
    ].join("\n");
    await writeFile(path.join(config.codexHome, "config.toml"), toml, {
      encoding: "utf8",
      mode: 0o600,
    });
  },

  processEnv: (config) => ({
    CODEX_HOME: config.codexHome,
    ARK_API_KEY: config.arkApiKey,
  }),

  isTerminalEvent: isCodexTerminalEvent,

  trace: {
    runtimeId: "codex",
    displayName: "Codex",
    correlationAttribute: "conversation.id",
    normalize: normalizeCodexEvent,
  },
};
