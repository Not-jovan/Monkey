import type { AuditHealth, TraceStatus } from "../types";
import { isSuccessfulAudit } from "./audit-status";

// What a trace page offers on the stack of audits above it, decided from the
// page's own trace rather than from whichever pane happens to be showing.
// Going deeper is a page-level move: the auditor pane is a preview of the
// audit, so opening it and opening the audit of the run are the same journey.
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

// The trigger and the way into its result both live on the auditor tab.
// View Audit Auditor stays off until an audit of this trace has actually
// started — an id in `action.view`, not the mere presence of the tab.
export function auditorTabActions(input: {
  pane: TracePane;
  action: AuditAction;
}): { showAuditAuditor: boolean; showViewAuditAuditor: boolean } {
  if (input.pane !== "auditor") {
    return { showAuditAuditor: false, showViewAuditAuditor: false };
  }
  return {
    showAuditAuditor: input.action.run,
    showViewAuditAuditor: input.action.view !== null,
  };
}

export function showDegradedRetry(input: {
  pane: TracePane;
  auditHealth: AuditHealth;
}): boolean {
  return input.pane === "auditor" && input.auditHealth === "degraded";
}
