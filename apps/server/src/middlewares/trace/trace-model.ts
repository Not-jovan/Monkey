import { z } from "zod";
import { runFailureSchema } from "../../failures.js";

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
  // Attribution for a failed run: which layer is at fault, and what to do.
  // Defaulted so traces written before the taxonomy existed still parse.
  failure: runFailureSchema.nullable().default(null),
  // Errors the agent hit and then recovered from. A run that succeeded after
  // five failures is a different quality signal from a clean one.
  recoveredErrorCount: z.number().default(0),
  // False once the output cap truncated the stream. A diagnosis must never
  // silently rest on evidence the platform knows it discarded.
  evidenceComplete: z.boolean().default(true),
  evidenceProblem: z.string().nullable().default(null),
  unrecognizedEvents: z.number(),
  // The trace this one audits, and how many audits deep that makes it. An
  // agent's own run is depth 0 with no target; the auditor that judged it is
  // depth 1, the auditor that judged *that* is depth 2, and so on with no
  // ceiling. Defaulted so traces written before auditors had traces still
  // parse as what they are.
  //
  // Load-bearing for more than display: the automatic audit subscription fires
  // only at depth 0. Everything above it is judged when someone asks and never
  // otherwise, which is the whole reason auditing an auditor cannot run away.
  auditOf: z.string().nullable().default(null),
  auditDepth: z.number().default(0),
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

// Whether this trace is an auditor's own run rather than an Agent's, which is
// true exactly when it names the trace it audits.
//
// This is the recursion guard, so it is deliberately narrow: an auditor's spans
// are real trace spans and raise the same events an Agent's do, and anything
// looser here would let the first of them enqueue an audit of the auditor that
// wrote it, without limit. Shared so the recorder, the run list and the auditor
// cannot disagree about which runs are judged on their own.
export function isAuditorTrace(trace: Pick<TraceRecord, "auditOf">): boolean {
  return typeof trace.auditOf === "string" && trace.auditOf.length > 0;
}

export function readAttribute(span: TraceSpan, key: string): string {
  const value = span.attributes[key];
  return typeof value === "string" ? value : "";
}

// Whether a span carries any record of what the agent actually did, as opposed
// to only what it was about to do. A tool span denied at its decision, or
// interrupted before its result arrived, has a name and nothing else — there is
// no payload to judge, and judging the name alone reports on the wrong thing.
// Shared so the recorder and the auditor cannot drift on what "judgeable" means.
export function hasJudgeableEvidence(span: TraceSpan): boolean {
  return ["arguments", "output", "prompt", "result"].some(
    (key) => readAttribute(span, key).length > 0,
  );
}
