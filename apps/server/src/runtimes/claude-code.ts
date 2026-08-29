import { collectorLogsUrl, type AppConfig } from "../config.js";
import { parseClaudeCodeEvent } from "../middlewares/trace/claude-code-events.js";
import type { NormalizedRuntimeEvent } from "../middlewares/trace/runtime-events.js";
import type { ParsedEvents, RuntimeDefinition } from "./types.js";

// `-p --output-format stream-json --verbose --permission-mode <mode>`
// verified against live runs (Claude Code CLI 2.1.250 on 2026-08-28,
// 2.1.251 on 2026-08-29): the system/init and result/success event shapes
// below match real output exactly, a bypassPermissions run really does execute
// Bash, and `--resume <sessionId>` continues the session in place: a second
// turn through the Launchpad reported the same session id as the first, which
// is what keeps its trace bound.
export function buildClaudeCodeArgs(
  request: { prompt: string; threadId: string | null },
  permissionMode: AppConfig["claudeCodePermissionMode"],
): string[] {
  const args = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    // Without this the CLI runs in its default mode, which asks before every
    // command and every write. Headless there is nobody to ask, so each one
    // is auto-denied — the CLI answers the model with "Claude requested
    // permissions to use Bash, but you haven't granted it yet." An agent in
    // that state reads files and reports back, and looks from the outside
    // like an agent that simply chose to do nothing.
    "--permission-mode",
    permissionMode,
  ];
  if (request.threadId) {
    // Resumes in place. `--fork-session` is the flag that would mint a new
    // session id instead ("branch off a copy"), and it is deliberately not
    // passed: a stable id across turns is what keeps the trace pipeline
    // bound to the same conversation.
    args.push("--resume", request.threadId);
  }
  return args;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Builds the most specific failure description the event actually carries.
// Verified against a live failing run (Claude Code 2.1.250): an auth failure
// arrives as `subtype: "success"` with `is_error: true`, `terminal_reason:
// "api_error"` and the message in `result` — so `subtype` alone is not a
// reliable failure signal, and `result` is not the only place the reason
// lives.
function describeResultFailure(event: Record<string, unknown>): string {
  const parts: string[] = [];
  // `result`/`error` are human-readable messages; when one is present it says
  // everything the machine codes would, so appending them is just noise.
  const human = asNonEmptyString(event.result) ?? asNonEmptyString(event.error);
  if (human) {
    parts.push(human);
  } else {
    // Otherwise every code we have is worth keeping — each is a different
    // slice of why it stopped.
    const reason = asNonEmptyString(event.terminal_reason);
    if (reason) parts.push(reason);
    const subtype = asNonEmptyString(event.subtype);
    if (subtype && subtype !== "success") parts.push("subtype=" + subtype);
  }

  const status = event.api_error_status;
  if (typeof status === "number" || asNonEmptyString(status)) {
    parts.push("api_error_status=" + String(status));
  }

  return parts.length > 0
    ? parts.join(" · ")
    : "Claude Code reported a failure with no error detail";
}

// Parses one line of `claude -p --output-format stream-json` stdout.
// `session_id`, `type: "result"`, `result`, `is_error`, `terminal_reason`,
// the `system`/`api_retry` shape, and
// `usage.{input_tokens,output_tokens,cache_read_input_tokens}` are all
// verified against live successful and failing runs (2026-08-28).
export function parseClaudeCodeEventLine(
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

  if (typeof event.session_id === "string" && event.session_id.length > 0) {
    parsed.threadId = event.session_id;
  }

  // The init event names the model this session actually runs on — Claude
  // Code resolves it from the account, so it isn't knowable from config.
  // Deliberately not read from api_request events: background calls (session
  // titles) run on a different, smaller model, so those would intermittently
  // report the wrong one.
  if (event.type === "system" && event.subtype === "init") {
    const model = asNonEmptyString(event.model);
    if (model) parsed.model = model;
  }

  // Retries carry the clearest diagnostic Claude Code emits (HTTP status plus
  // an error slug) and are the only signal at all when the process is killed
  // before it ever produces a result event.
  if (event.type === "system" && event.subtype === "api_retry") {
    const reason = asNonEmptyString(event.error) ?? "request failed";
    const status = event.error_status;
    const attempt = event.attempt;
    parsed.errors.push(
      "Claude Code API retry" +
        (typeof attempt === "number" ? " " + attempt : "") +
        (typeof event.max_retries === "number" ? "/" + event.max_retries : "") +
        ": " +
        reason +
        (typeof status === "number" ? " (HTTP " + status + ")" : ""),
    );
    return;
  }

  // Any event can carry the real reason — an auth failure surfaces as an
  // `assistant` event with `error: "authentication_failed"` well before the
  // result event, which may then report only a generic subtype. Capture it
  // wherever it appears rather than guessing which event type owns it.
  if (event.type !== "result") {
    const embedded = asNonEmptyString(event.error);
    if (embedded) {
      const kind = asNonEmptyString(event.type) ?? "event";
      parsed.errors.push(kind + " error: " + embedded);
    }
    return;
  }

  // `is_error` is authoritative; `subtype` is not. Checking subtype alone let
  // an auth failure ("Not logged in · Please run /login") be recorded as the
  // agent's successful reply.
  const failed =
    event.is_error === true ||
    (typeof event.subtype === "string" && event.subtype.startsWith("error"));

  if (failed) {
    parsed.errors.push(describeResultFailure(event));
  } else if (typeof event.result === "string") {
    parsed.messages.push(event.result);
  }

  if (event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cache_read_input_tokens === "number"
        ? { cachedInputTokens: usage.cache_read_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }
}

// Model calls the CLI makes for its own housekeeping, on the session's
// telemetry stream but not on the agent's behalf. Observed live: naming the
// session costs a full haiku call, and it lands *first* — so before this was
// filtered it became the run's "Model · plan" span, contributed 926 input
// tokens to the run's usage, and pushed every later model-call label one step
// out of phase.
//
// A denylist, not an allowlist of "sdk": a background source we have not seen
// yet should show up as a visible extra span, which someone will notice and
// come fix, rather than being silently swallowed along with a real turn.
const BACKGROUND_QUERY_SOURCES = new Set(["generate_session_title"]);

function normalizeClaudeCodeEvent(
  attributes: Record<string, unknown>,
): NormalizedRuntimeEvent | null {
  const parsed = parseClaudeCodeEvent(attributes);
  if (!parsed) return null;
  const { event } = parsed;

  if (
    (event["event.name"] === "api_request" ||
      event["event.name"] === "assistant_response") &&
    event.query_source !== undefined &&
    BACKGROUND_QUERY_SOURCES.has(event.query_source)
  ) {
    return { kind: "ignored" };
  }

  switch (event["event.name"]) {
    case "user_prompt": {
      return {
        kind: "user_prompt",
        promptLength: event.prompt_length,
        prompt: event.prompt,
      };
    }
    case "api_request": {
      // Claude Code reports usage in the same record as the request, unlike
      // Codex which reports it later via a separate stream event — so this
      // is the only "model_call" this runtime ever emits for a successful
      // call, with usage already attached; there is no "model_call_usage"
      // counterpart.
      return {
        kind: "model_call",
        spanName: "claude_code.api_request",
        durationMs: event.duration_ms ?? 0,
        failed: false,
        usage: {
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          cachedTokens: event.cache_read_tokens,
        },
      };
    }
    case "api_error": {
      return {
        kind: "model_call",
        spanName: "claude_code.api_request",
        durationMs: event.duration_ms ?? 0,
        failed: true,
        statusCode: event.status_code,
        attempt: event.attempt,
        errorMessage: event.error,
      };
    }
    case "tool_decision": {
      return {
        kind: "tool_decision",
        toolName: event.tool_name,
        callId: event.tool_use_id,
        decision: event.decision === "reject" ? "denied" : "approved",
        rawDecision: event.decision,
        source: event.source ?? "unknown",
      };
    }
    case "tool_result": {
      return {
        kind: "tool_result",
        toolName: event.tool_name,
        callId: event.tool_use_id,
        // tool_input is the cleaner, more structured of the two raw-args
        // JSON strings Claude Code sends (see claude-code-events.ts); fall
        // back to tool_parameters when it's absent.
        arguments: event.tool_input ?? event.tool_parameters,
        durationMs: event.duration_ms,
        success: event.success === true || event.success === "true",
        // Confirmed absent on this signal (claude-code-events.ts header
        // note 2) — only input content and sizes are ever delivered, never
        // output content. Left undefined rather than guessing a field name.
        output: undefined,
        mcpServer: event.mcp_server_scope,
      };
    }
    default: {
      return { kind: "ignored" };
    }
  }
}

export const claudeCodeRuntime: RuntimeDefinition = {
  id: "claude-code",
  bin: (config) => config.claudeCodeBin,
  homeDir: (config) => config.claudeCodeHome,
  homeEnvVar: "CLAUDE_CONFIG_DIR",

  buildArgs: (request, _workspacePath, config) =>
    buildClaudeCodeArgs(request, config.claudeCodePermissionMode),

  parseEventLine: parseClaudeCodeEventLine,

  // Nothing to write to disk — Claude Code is configured entirely through
  // env vars passed to each process (see processEnv), unlike Codex's
  // config.toml file.
  async bootstrap() {},

  processEnv: (config, collectorToken) => ({
    CLAUDE_CONFIG_DIR: config.claudeCodeHome,
    // Exactly one credential, never both: Claude Code ranks
    // ANTHROPIC_API_KEY (a Console key, billed against Console credit)
    // above CLAUDE_CODE_OAUTH_TOKEN (a subscription token from
    // `claude setup-token`), and under headless `-p` an API key that is
    // present is always used. Forwarding both — even with the key empty —
    // would silently keep billing the Console balance.
    ...(config.claudeCodeOauthToken
      ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeCodeOauthToken }
      : { ANTHROPIC_API_KEY: config.anthropicApiKey }),
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    // Used verbatim, unlike OTEL_EXPORTER_OTLP_ENDPOINT which gets
    // /v1/logs auto-suffixed — our collector route isn't at that path.
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collectorLogsUrl(config),
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-collector-token=" + collectorToken,
    // Prompts/tool details are captured deliberately, same rationale as
    // Codex's log_user_prompt=true — the collector masks secrets before
    // anything is persisted or displayed. Confirmed live: with this flag on,
    // the logs signal carries tool call *input* (tool_parameters/tool_input)
    // but never output content, only its byte size — see
    // claude-code-events.ts's header note 2.
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
  }),

  trace: {
    runtimeId: "claude-code",
    displayName: "Claude Code",
    correlationAttribute: "session.id",
    normalize: normalizeClaudeCodeEvent,
  },
};
