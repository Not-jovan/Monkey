import { z } from "zod";
import type { AuditorCallStatus } from "./auditor-model.js";
import type { StepCheckOutcome } from "./step-findings.js";

export const CHECK_IDS = [
  "summary",
  "intent",
  "injection",
  "secrets",
  "network",
  "tool",
  "sinks",
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export const cachedCheckSchema = z.object({
  // False when the step had no subject for this check (no URL, no tool args).
  applicable: z.boolean().default(true),
  status: z.enum(["completed", "degraded", "failed"]),
  failure: z.string().nullable().default(null),
  label: z.string().default(""),
  verdict: z.unknown().nullable().default(null),
});

export type CachedCheck = z.infer<typeof cachedCheckSchema>;

export type CachedChecks = Partial<Record<CheckId, CachedCheck>>;

// A completed or degraded check already produced a verdict. Failed (timeout,
// outage) and missing entries have to be asked again.
export function cachedCheckReusable(cached: CachedCheck | undefined): boolean {
  if (!cached) return false;
  if (!cached.applicable) return true;
  return cached.status === "completed" || cached.status === "degraded";
}

export function stepNeedsRetry(
  checks: Partial<Record<string, CachedCheck>> | undefined,
): boolean {
  if (!checks) return true;
  for (const id of ["summary", "intent", "injection"] as const) {
    if (!cachedCheckReusable(checks[id])) return true;
  }
  for (const cached of Object.values(checks)) {
    if (!cachedCheckReusable(cached)) return true;
  }
  return false;
}

export function storeCheck<Verdict>(
  outcome: StepCheckOutcome<Verdict> | null,
): CachedCheck {
  if (outcome === null) {
    return {
      applicable: false,
      status: "completed",
      failure: null,
      label: "",
      verdict: null,
    };
  }
  return {
    applicable: true,
    status: outcome.status,
    failure: outcome.failure,
    label: outcome.label,
    verdict: outcome.verdict,
  };
}

export function restoreCheck<Verdict>(
  cached: CachedCheck | undefined,
  schema: z.ZodType<Verdict>,
): StepCheckOutcome<Verdict> | null | "run" {
  if (!cached) return "run";
  if (!cached.applicable) return null;
  if (cached.status === "failed") return "run";
  const parsed = schema.safeParse(cached.verdict);
  if (!parsed.success) return "run";
  return {
    verdict: parsed.data,
    status: cached.status,
    failure: cached.failure,
    label: cached.label,
  };
}

export function healthOfCheck(status: AuditorCallStatus) {
  if (status === "completed") return "ok" as const;
  return status;
}
