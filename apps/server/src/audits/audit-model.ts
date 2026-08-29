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
  // The specification version this finding was actually judged against, read
  // with the spec rather than after the model call. The document carries one
  // too, but that is last-writer-wins: a run spanning a spec change would
  // otherwise attribute all of its findings to whichever version happened to
  // be current when the last one landed. Defaulted for audit files written
  // before findings carried it.
  intentId: z.string().default(""),
  type: z.enum(["warning", "error"]),
  // "audit-health" is the auditor reporting on itself. Kept apart from the two
  // agent categories because "our auditor could not run" and "the agent
  // misbehaved" are opposite claims, and counting them together made a model
  // outage look like an agent defect.
  // "reliability" is about how the agent behaved rather than whether it was
  // safe or on-spec: retrying a call that has already failed, for instance.
  category: z.enum([
    "intent-check",
    "security",
    "reliability",
    "audit-health",
  ]),
  finding: z.string(),
});

export type AuditTraceStep = z.infer<typeof auditTraceStepSchema>;

export const auditHealthSchema = z.enum(["ok", "degraded", "failed"]);
export type AuditHealth = z.infer<typeof auditHealthSchema>;

// Worst-case wins: one failed policy call degrades the whole record rather than
// being averaged away by the calls that did work.
const HEALTH_RANK: Record<AuditHealth, number> = {
  ok: 0,
  degraded: 1,
  failed: 2,
};

export function worstHealth(left: AuditHealth, right: AuditHealth): AuditHealth {
  return HEALTH_RANK[right] > HEALTH_RANK[left] ? right : left;
}

export const chatAuditSchema = z.object({
  agentId: z.string(),
  intentId: z.string(),
  // Defaulted so audit files written before health was tracked still parse.
  health: auditHealthSchema.default("ok"),
  contextSummary: z.string(),
  summary: z.object({
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
    // Optional so a caller reporting on the auditor itself, rather than on the
    // agent against a spec, is not forced to invent one.
    intentId?: string;
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
      intentId: identity.intentId ?? "",
      type,
      category,
      finding,
    });
  });
  return steps;
}

// AGENTS.md no longer matches the agent's recorded instructions. Which claim
// this is depends entirely on when it was noticed: an edit made during a run is
// attributable to the agent and is a security finding, while a file that was
// already wrong when the run began names no culprit and is the auditor
// reporting that it may have judged against a spec the agent never read.
export function instructionsDriftFinding(
  identity: {
    id: string;
    traceId: string;
    agentId: string;
    intentId?: string;
  },
  when: "before" | "during",
) {
  return auditSteps({ ...identity, spanId: null }, (push) =>
    push(
      "error",
      when === "during" ? "security" : "audit-health",
      when === "during"
        ? "This run modified AGENTS.md, the file it reads its own instructions " +
            "from. The agent has edited the specification it is governed by, so " +
            "the recorded instructions no longer describe what it was following."
        : "AGENTS.md did not match this agent's recorded instructions when the " +
            "run began. The agent was following a specification the platform " +
            "did not write, and this run was audited against one it may never " +
            "have read.",
    ),
  );
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
    // Egress is reported even when the auditor judged the credential relevant.
    // Detection here is deterministic; a judged call may soften the wording but
    // must never delete the finding, or a model's opinion becomes the only
    // thing standing between a leaked credential and silence.
    if (exposure.relevant === true && exposure.location !== "request") continue;
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
          : exposure.relevant
            ? " and the auditor judged it relevant to this operation."
            : " and is unrelated to the operation.") +
        (exposure.reason ? " " + exposure.reason : ""),
    );
  }
}
