export type AuditType = "security" | "intent";
export type AuditPhase = "step" | "run";
export type AuditStatus = "completed" | "degraded" | "failed";

export interface SecretExposureFinding {
  location: "request" | "response";
  secretType: string;
  // Detection is deterministic; relevance is judged, so it is null whenever
  // the audit model could not be reached.
  relevant: boolean | null;
  reason: string;
}

export interface NewObjectiveFinding {
  objective: string;
  requestedByUser: boolean;
  // AUDIT_PLAN only warns once the agent acts on an objective it was not
  // given: an injected instruction the agent ignored is worth recording, not
  // warning about.
  actedUpon: boolean;
}

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
  // Intent policies (AUDIT_PLAN 4.A and 4.B).
  notInAlignment: string[];
  newObjectives: NewObjectiveFinding[];
  // Security policies (AUDIT_PLAN Security A and B). Both start from
  // deterministic detection so they stand even with no model available.
  networkViolations: string[];
  secretExposures: SecretExposureFinding[];
  // Intent audits carry a compressed summary forward to the next run so the
  // original goal survives context growth.
  contextSummary: string | null;
  latencyMs: number;
  createdAt: string;
}

// The flat shape AUDIT_PLAN specifies as the auditor's output. One record can
// yield several of these, so it is derived rather than stored: the record
// keeps the evidence, this is the view.
export interface AuditTraceStep {
  id: string;
  traceId: string;
  agentId: string;
  type: "warning" | "error";
  category: "intent-check" | "security";
  finding: string;
}

export function toAuditTraceSteps(record: AuditRecord): AuditTraceStep[] {
  const steps: AuditTraceStep[] = [];
  let sequence = 0;
  const push = (
    type: AuditTraceStep["type"],
    category: AuditTraceStep["category"],
    finding: string,
  ) => {
    sequence += 1;
    steps.push({
      id: record.id + "#" + sequence,
      traceId: record.traceId,
      agentId: record.agentId,
      type,
      category,
      finding,
    });
  };

  for (const entry of record.notInAlignment) {
    push("warning", "intent-check", entry);
  }
  for (const objective of record.newObjectives) {
    if (objective.requestedByUser || !objective.actedUpon) continue;
    push(
      "warning",
      "intent-check",
      "The agent acted on an objective the user never asked for: " +
        objective.objective,
    );
  }
  for (const url of record.networkViolations) {
    push(
      "warning",
      "security",
      "Contacted " + url + ", which is not on the configured whitelist.",
    );
  }
  for (const exposure of record.secretExposures) {
    if (exposure.relevant === true) continue;
    const verb =
      exposure.location === "request" ? "was sent outward" : "was exposed";
    push(
      "warning",
      "security",
      exposure.secretType +
        " " +
        verb +
        (exposure.relevant === null
          ? " and its relevance could not be assessed."
          : " and is unrelated to the operation.") +
        (exposure.reason ? " " + exposure.reason : ""),
    );
  }
  for (const finding of record.findings) {
    if (
      finding === "network-whitelist-violation" ||
      finding === "secret-egress" ||
      finding === "intent-deviation"
    ) {
      continue;
    }
    push("warning", "security", finding + (record.reason ? ": " + record.reason : ""));
  }
  if (record.status === "failed") {
    push(
      "error",
      record.type === "intent" ? "intent-check" : "security",
      "The audit could not be completed" +
        (record.reason ? ": " + record.reason : "."),
    );
  }
  return steps;
}
