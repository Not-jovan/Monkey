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

export interface AuditTraceStep {
  id: string;
  traceId: string;
  agentId: string;
  // Null on run-level findings; set when the finding belongs to a span.
  spanId: string | null;
  type: "warning" | "error";
  category: "intent-check" | "security";
  finding: string;
}

export function auditSteps(
  identity: {
    id: string;
    traceId: string;
    agentId: string;
    spanId: string | null;
  },
  write: (
    push: (
      type: AuditTraceStep["type"],
      category: AuditTraceStep["category"],
      finding: string,
    ) => void,
  ) => void,
): AuditTraceStep[] {
  const steps: AuditTraceStep[] = [];
  let sequence = 0;
  write((type, category, finding) => {
    sequence += 1;
    steps.push({
      id: identity.id + "#" + sequence,
      traceId: identity.traceId,
      agentId: identity.agentId,
      spanId: identity.spanId,
      type,
      category,
      finding,
    });
  });
  return steps;
}

export function emitPolicyFindings(
  push: (
    type: AuditTraceStep["type"],
    category: AuditTraceStep["category"],
    finding: string,
  ) => void,
  policies: {
    notInAlignment: string[];
    newObjectives: NewObjectiveFinding[];
    networkViolations: string[];
    secretExposures: SecretExposureFinding[];
  },
) {
  for (const entry of policies.notInAlignment) {
    push("warning", "intent-check", entry);
  }
  for (const objective of policies.newObjectives) {
    if (objective.requestedByUser || !objective.actedUpon) continue;
    push(
      "warning",
      "intent-check",
      "The agent acted on an objective the user never asked for: " +
        objective.objective,
    );
  }
  for (const url of policies.networkViolations) {
    push(
      "warning",
      "security",
      "Contacted " + url + ", which is not on the configured whitelist.",
    );
  }
  for (const exposure of policies.secretExposures) {
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
}

