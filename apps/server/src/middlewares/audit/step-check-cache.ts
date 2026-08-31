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

export interface CheckReuse {
  // A requested retry of a finished pass. Degraded checks already have a
  // fallback verdict; asking again is the point of the retry — the primary
  // model may be back. Interrupted resumes still reuse them.
  retryDegraded?: boolean;
}

// A completed or degraded check already produced a verdict. Failed (timeout,
// outage) and missing entries have to be asked again.
export function cachedCheckReusable(
  cached: CachedCheck | undefined,
  options?: CheckReuse,
): boolean {
  if (!cached) return false;
  if (!cached.applicable) return true;
  if (cached.status === "completed") return true;
  if (cached.status === "degraded") return options?.retryDegraded !== true;
  return false;
}

export function stepNeedsRetry(
  checks: Partial<Record<string, CachedCheck>> | undefined,
  options?: CheckReuse,
): boolean {
  if (!checks) return true;
  for (const id of ["summary", "intent", "injection"] as const) {
    if (!cachedCheckReusable(checks[id], options)) return true;
  }
  for (const cached of Object.values(checks)) {
    if (!cachedCheckReusable(cached, options)) return true;
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
  options?: CheckReuse,
): StepCheckOutcome<Verdict> | null | "run" {
  if (!cached) return "run";
  if (!cached.applicable) return null;
  if (cached.status === "failed") return "run";
  if (cached.status === "degraded" && options?.retryDegraded) return "run";
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
