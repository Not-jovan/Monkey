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
  // Whether this trace can be audited on request. An Agent run is judged
  // automatically and is never asked to be, so this is auditors only.
  run: boolean;
}

export function auditAction(input: {
  auditOf: string | null;
  status: TraceStatus;
  auditComplete: boolean;
  auditHealth: AuditHealth;
  auditTraceId: string | null;
}): AuditAction {
  const isAuditor =
    typeof input.auditOf === "string" && input.auditOf.length > 0;
  return {
    view: input.auditTraceId,
    run: isAuditor && input.status !== "running" && !isSuccessfulAudit(input),
  };
}
