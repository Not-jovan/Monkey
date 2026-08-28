import { z } from "zod";

export interface SecretExposureFinding {
  location: "request" | "response";
  secretType: string;
  relevant: boolean | null;
  reason: string;
}

export interface NewObjectiveFinding {
  objective: string;
  requestedByUser: boolean;
  actedUpon: boolean;
}

export const auditTraceStepSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  agentId: z.string(),
  spanId: z.string().nullable(),
  type: z.enum(["warning", "error"]),
  category: z.enum(["intent-check", "security"]),
  finding: z.string(),
});

export type AuditTraceStep = z.infer<typeof auditTraceStepSchema>;

export const chatAuditSchema = z.object({
  agentId: z.string(),
  intentId: z.string(),
  contextSummary: z.string(),
  summary: z.object({
    priorRollout: z.string(),
    tokenSummary: z.object({
      input: z.number(),
      output: z.number(),
      cached: z.number(),
      reasoning: z.number(),
    }),
    startTime: z.number(),
    endTime: z.number(),
    model: z.string(),
  }),
  spanAudit: z.record(z.string(), z.array(auditTraceStepSchema)),
  runAudit: z.array(auditTraceStepSchema),
});

export type ChatAudit = z.infer<typeof chatAuditSchema>;

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
) {
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
