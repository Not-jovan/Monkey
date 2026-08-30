import type { AuditHealth } from "../types";

// An auditor is not judged on its own. A requested audit can also fail
// outright, leaving a completed record with no verdict. Findings are only
// trustworthy once a pass finished and actually produced one.
export function isSuccessfulAudit(input: {
  auditComplete: boolean;
  auditHealth: AuditHealth;
}): boolean {
  return input.auditComplete && input.auditHealth !== "failed";
}
