import { z } from "zod";

// Schemas verified against a live emitting instance (Claude Code CLI 2.1.250,
// 2026-08-28): CLAUDE_CODE_ENABLE_TELEMETRY=1 with OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
// pointed at a throwaway local collector, capturing real `claude -p
// --output-format stream-json` runs including a tool call. Findings that
// differ from the docs / from Codex's convention:
//
//  1. The event name attribute is the SHORT, unqualified form
//     ("user_prompt", "api_request", "tool_decision", "tool_result") — NOT
//     "claude_code.user_prompt" etc. The qualified name only appears in the
//     OTLP LogRecord's own `body.stringValue` field, which this schema does
//     not need since "event.name" alone already discriminates the variants.
//     (Codex, by contrast, puts the fully-qualified name directly in its
//     "event.name" attribute.)
//  2. Tool *output* content is never present on this signal, even with
//     OTEL_LOG_TOOL_DETAILS=1 — only tool *input* (as `tool_parameters` and
//     `tool_input`, two differently-shaped JSON strings of the same call)
//     and byte sizes (`tool_input_size_bytes`, `tool_result_size_bytes`).
//     This is a real, confirmed limitation, not just an unverified guess:
//     the audit pipeline's secret-detection/network-whitelist checks, which
//     read tool call arguments *and output* off span attributes, only ever
//     see the input half for this runtime.
//  3. `claude_code.api_error` was not observed live (the verification run
//     had no failing request) — its shape below is still the best-effort
//     reconstruction from the docs and should be treated as unverified.
export const ClaudeCodeCommonAttributes = z.object({
  "event.name": z.string(),
  "session.id": z.string().optional(),
  "prompt.id": z.string().optional(),
  model: z.string().optional(),
  "app.entrypoint": z.string().optional(),
  "terminal.type": z.string().optional(),
  "organization.id": z.string().optional(),
  "user.id": z.string().optional(),
});

export const ClaudeCodeUserPrompt = z.object({
  "event.name": z.literal("user_prompt"),
  prompt_length: z.coerce.number(),
  // Redacted ("[REDACTED]"/absent) unless OTEL_LOG_USER_PROMPTS=1; the
  // launchpad sets that, same rationale as Codex's log_user_prompt=true —
  // the collector masks secrets before anything is persisted or displayed.
  prompt: z.string().optional(),
  command_name: z.string().optional(),
  command_source: z.string().optional(),
});

export const ClaudeCodeApiRequest = z.object({
  "event.name": z.literal("api_request"),
  model: z.string().optional(),
  duration_ms: z.coerce.number().optional(),
  input_tokens: z.coerce.number().optional(),
  output_tokens: z.coerce.number().optional(),
  cache_read_tokens: z.coerce.number().optional(),
  cache_creation_tokens: z.coerce.number().optional(),
  cost_usd: z.coerce.number().optional(),
  request_id: z.string().optional(),
});

// Unverified live — see file header note 3.
export const ClaudeCodeApiError = z.object({
  "event.name": z.literal("api_error"),
  model: z.string().optional(),
  error: z.string().optional(),
  status_code: z.coerce.number().optional(),
  duration_ms: z.coerce.number().optional(),
  attempt: z.coerce.number().optional(),
  request_id: z.string().optional(),
});

// Confirmed live: fires alongside api_request but carries no data this
// pipeline uses (the model's response text comes from the runner's own
// stdout stream instead, via parseClaudeCodeEventLine — see file header of
// runtimes/claude-code.ts). Only declared so it counts as a recognized,
// intentionally-ignored event rather than inflating TraceRecord's
// unrecognizedEvents counter for something that fires on every turn.
export const ClaudeCodeAssistantResponse = z.object({
  "event.name": z.literal("assistant_response"),
});

export const ClaudeCodeToolDecision = z.object({
  "event.name": z.literal("tool_decision"),
  tool_name: z.string(),
  tool_use_id: z.string(),
  decision: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(["accept", "reject"])),
  source: z.string().optional(),
  tool_source: z.string().optional(),
  // JSON string of the raw tool call args, e.g. {"bash_command":"ls",...}.
  tool_parameters: z.string().optional(),
});

export const ClaudeCodeToolResult = z.object({
  "event.name": z.literal("tool_result"),
  tool_name: z.string(),
  tool_use_id: z.string().optional(),
  // Observed on the wire as the string "true"/"false", not a JSON boolean.
  success: z.union([z.boolean(), z.enum(["true", "false"])]),
  duration_ms: z.coerce.number(),
  error_type: z.string().optional(),
  // Same raw-args JSON string as tool_decision.tool_parameters.
  tool_parameters: z.string().optional(),
  // A second, more structured JSON string of just the tool's actual input
  // shape, e.g. {"command":"ls","description":"..."} for Bash — distinct
  // from tool_parameters above. No output-content field exists (see file
  // header note 2); only sizes are available.
  tool_input: z.string().optional(),
  tool_input_size_bytes: z.coerce.number().optional(),
  tool_result_size_bytes: z.coerce.number().optional(),
  mcp_server_scope: z.string().optional(),
});

const claudeCodeEventVariants = z.discriminatedUnion("event.name", [
  ClaudeCodeUserPrompt,
  ClaudeCodeApiRequest,
  ClaudeCodeApiError,
  ClaudeCodeAssistantResponse,
  ClaudeCodeToolDecision,
  ClaudeCodeToolResult,
]);

export const ClaudeCodeEvent = claudeCodeEventVariants;
export type ClaudeCodeEvent = z.infer<typeof claudeCodeEventVariants>;
export type ClaudeCodeCommon = z.infer<typeof ClaudeCodeCommonAttributes>;

export function parseClaudeCodeEvent(attributes: Record<string, unknown>) {
  const event = claudeCodeEventVariants.safeParse(attributes);
  const common = ClaudeCodeCommonAttributes.safeParse(attributes);
  if (!event.success || !common.success) {
    return null;
  }
  return { event: event.data, common: common.data };
}
