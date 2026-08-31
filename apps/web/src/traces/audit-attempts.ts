import type { AuditAttempt, TraceStatus } from "../types";

// Shown oldest first so a failed pass and the retry that followed it read
// left to right as they happened. The API lists newest first because that is
// the one auditTraceId names.
export function attemptsOldestFirst(attempts: AuditAttempt[]): AuditAttempt[] {
  return [...attempts].reverse();
}

export function auditAttemptLabel(input: {
  number: number;
  latest: boolean;
  status: TraceStatus;
}): string {
  let label = "Attempt " + input.number;
  if (input.status !== "completed") label += " · " + input.status;
  if (input.latest) label += " · latest";
  return label;
}
