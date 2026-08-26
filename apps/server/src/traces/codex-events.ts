import { z } from "zod";

// Schemas mirror the OTel log events Codex 0.111.0 emits (verified against a
// live containerized run on 2026-08-26). Values arrive as strings, hence the
// coercions. Two deviations from the published docs observed in real data:
// tool_decision.source is capitalized ("Config"), and mcp_servers arrives as a
// comma-joined string rather than an array.
export const CodexCommonAttributes = z.object({
  "event.name": z.string(),
  "event.timestamp": z.string().optional(),
  "conversation.id": z.string().optional(),
  "app.version": z.string().optional(),
  auth_mode: z.string().optional(),
  "user.account_id": z.string().optional(),
  "user.email": z.string().optional(),
  originator: z.string().optional(),
  "service.name": z.string().optional(),
  "terminal.type": z.string().optional(),
  model: z.string().optional(),
  slug: z.string().optional(),
  service_tier: z.string().optional(),
  model_reasoning_effort: z.string().optional(),
  env: z.string().optional(),
});

export const CodexStartupPhase = z.object({
  "event.name": z.literal("codex.startup_phase"),
  "startup.phase": z.string(),
  "startup.status": z.string().nullable().optional(),
  duration_ms: z.coerce.number().optional(),
});

export const CodexConversationStarts = z.object({
  "event.name": z.literal("codex.conversation_starts"),
  provider_name: z.string(),
  reasoning_effort: z.string().optional(),
  reasoning_summary: z.string().optional(),
  context_window: z.coerce.number().optional(),
  auto_compact_token_limit: z.coerce.number().optional(),
  approval_policy: z.string().optional(),
  sandbox_policy: z.string().optional(),
  mcp_servers: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((value) => {
      if (Array.isArray(value)) return value;
      if (!value) return [];
      return value.split(",").filter((entry) => entry.length > 0);
    }),
  active_profile: z.string().optional(),
});

export const CodexApiRequest = z.object({
  "event.name": z.literal("codex.api_request"),
  attempt: z.coerce.number().optional(),
  duration_ms: z.coerce.number().optional(),
  "http.response.status_code": z.coerce.number().optional(),
  "error.message": z.string().optional(),
});

export const CodexSseEvent = z.object({
  "event.name": z.literal("codex.sse_event"),
  "event.kind": z.string(),
  duration_ms: z.coerce.number().optional(),
  "error.message": z.string().optional(),

  // Present on response.completed
  input_token_count: z.coerce.number().optional(),
  output_token_count: z.coerce.number().optional(),
  cached_token_count: z.coerce.number().optional(),
  cache_write_token_count: z.coerce.number().optional(),
  reasoning_token_count: z.coerce.number().optional(),
  tool_token_count: z.coerce.number().optional(),
  ttft_ms: z.coerce.number().optional(),
});

export const CodexUserPrompt = z.object({
  "event.name": z.literal("codex.user_prompt"),
  prompt_length: z.coerce.number(),
  // "[REDACTED]" unless log_user_prompt = true; the launchpad enables it and
  // masks secrets itself before anything is stored.
  prompt: z.string().optional(),
  text_input_count: z.coerce.number().optional(),
  image_input_count: z.coerce.number().optional(),
  local_image_input_count: z.coerce.number().optional(),
});

export const CodexToolDecision = z.object({
  "event.name": z.literal("codex.tool_decision"),
  tool_name: z.string(),
  call_id: z.string(),
  decision: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(
      z.enum([
        "approved",
        "approved_for_session",
        "denied",
        "abort",
        "approved_execpolicy_amendment",
      ]),
    ),
  source: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(["config", "user"])),
});

export const CodexToolResult = z.object({
  "event.name": z.literal("codex.tool_result"),
  tool_name: z.string(),
  call_id: z.string().optional(),
  arguments: z.string().optional(),
  duration_ms: z.coerce.number(),
  // Codex emits these as strings: "true" / "false"
  success: z.enum(["true", "false"]),
  output: z.string().optional(),
  mcp_server: z.string().optional(),
  mcp_server_origin: z.string().optional(),
});

export const CodexWebsocketConnect = z.object({
  "event.name": z.literal("codex.websocket_connect"),
  duration_ms: z.coerce.number().optional(),
  success: z.string().optional(),
  "error.message": z.string().optional(),
  connection_reused: z.string().optional(),
});

export const CodexWebsocketRequest = z.object({
  "event.name": z.literal("codex.websocket_request"),
  duration_ms: z.coerce.number().optional(),
  success: z.string().optional(),
  "error.message": z.string().optional(),
  connection_reused: z.string().optional(),
});

export const CodexWebsocketEvent = z.object({
  "event.name": z.literal("codex.websocket_event"),
  "event.kind": z.string().optional(),
  duration_ms: z.coerce.number().optional(),
  success: z.string().optional(),
  "error.message": z.string().optional(),
});

export const CodexTurnTTFT = z.object({
  "event.name": z.literal("codex.turn_ttft"),
  duration_ms: z.coerce.number(),
});

export const CodexPluginInstallElicitationSent = z.object({
  "event.name": z.literal("codex.plugin_install_elicitation_sent"),
  tool_type: z.string(),
  tool_id: z.string(),
  tool_name: z.string(),
});

const codexEventVariants = z.discriminatedUnion("event.name", [
  CodexStartupPhase,
  CodexConversationStarts,
  CodexApiRequest,
  CodexSseEvent,
  CodexUserPrompt,
  CodexToolDecision,
  CodexToolResult,
  CodexWebsocketConnect,
  CodexWebsocketRequest,
  CodexWebsocketEvent,
  CodexTurnTTFT,
  CodexPluginInstallElicitationSent,
]);

export const CodexEvent = codexEventVariants;
export type CodexEvent = z.infer<typeof codexEventVariants>;
export type CodexCommon = z.infer<typeof CodexCommonAttributes>;

export function parseCodexEvent(attributes: Record<string, unknown>) {
  const event = codexEventVariants.safeParse(attributes);
  const common = CodexCommonAttributes.safeParse(attributes);
  if (!event.success || !common.success) {
    return null;
  }
  return { event: event.data, common: common.data };
}
