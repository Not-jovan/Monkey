export type AuditType = "security" | "intent";
export type AuditPhase = "step" | "run";
export type AuditStatus = "completed" | "degraded" | "failed";

export type AuditTraceStep = {
  id: string;
  traceId: string;
  agentId: string;
  type: "warning" | "error";
  category: "intent-check" | "security";
  finding: string;
};


export interface AuditRecord {
  version: 1;
  id: string;
  traceId: string;
  agentId: string;
  // Step audits point at the span they examined; run audits cover the trace.
  spanId: string | null;
  phase: AuditPhase;
  type: AuditType;
  status: AuditStatus;
  warning: boolean;
  model: string | null;
  findings: string[];
  reason: string;
  // Intent audits carry a compressed summary forward to the next run so the
  // original goal survives context growth.
  contextSummary: string | null;
  latencyMs: number;
  createdAt: string;
}
