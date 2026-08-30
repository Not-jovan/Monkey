import type { AuditHealth, TraceStatus } from "../types";
import { isSuccessfulAudit } from "./audit-status";

// What a trace page offers on the stack of audits above it, decided from the
// page's own trace and offered on either tab. Going deeper is a page-level
// move: the auditor pane is a preview of the audit, so opening it and opening
// the audit of the run are the same journey. Gating this on the auditor tab
// stranded whoever followed the link — they landed on the run tab of the trace
// they had just opened with no way to audit it from there.
//
// The two are separate rather than one of three states because a failed pass
// leaves both at once — an auditor trace worth reading, and no verdict to show
// for it, so the trigger has to stay for the retry.
export interface AuditAction {
  // The audit to open, once one has been started for this trace.
  view: string | null;
  // Whether this trace can be audited on request. Automatic judging covers
  // depth 0 once; a failed or unfinished pass can be asked again.
  run: boolean;
}

export function auditAction(input: {
  auditOf: string | null;
  status: TraceStatus;
  auditComplete: boolean;
  auditHealth: AuditHealth;
  auditTraceId: string | null;
}): AuditAction {
  return {
    view: input.auditTraceId,
    run: input.status !== "running" && !isSuccessfulAudit(input),
  };
}

export type TracePane = "run" | "auditor";

export function showDegradedRetry(input: {
  pane: TracePane;
  auditHealth: AuditHealth;
}): boolean {
  return input.pane === "auditor" && input.auditHealth === "degraded";
}
