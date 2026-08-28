import { z } from "zod";

export const spanKindSchema = z.enum([
  "run",
  "user_action",
  "turn",
  "model_call",
  "tool_call",
  "system",
]);
export const spanStatusSchema = z.enum(["running", "ok", "error"]);
export const spanActorSchema = z.enum(["user", "agent", "system"]);
export const traceStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type SpanKind = z.infer<typeof spanKindSchema>;
export type SpanStatus = z.infer<typeof spanStatusSchema>;
export type SpanActor = z.infer<typeof spanActorSchema>;
export type TraceStatus = z.infer<typeof traceStatusSchema>;

export const traceSpanSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  label: z.string(),
  kind: spanKindSchema,
  actor: spanActorSchema,
  status: spanStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  error: z.string().nullable(),
});

export type TraceSpan = z.infer<typeof traceSpanSchema>;

export const traceUsageSchema = z.object({
  inputTokens: z.number(),
  cachedTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  toolTokens: z.number(),
});

export type TraceUsage = z.infer<typeof traceUsageSchema>;

export const traceRecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  agentId: z.string(),
  conversationId: z.string().nullable(),
  status: traceStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  prompt: z.string(),
  model: z.string().nullable(),
  usage: traceUsageSchema,
  failingSpanId: z.string().nullable(),
  unrecognizedEvents: z.number(),
  spans: z.array(traceSpanSchema),
});

export type TraceRecord = z.infer<typeof traceRecordSchema>;

export const emptyUsage = () => ({
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolTokens: 0,
});
