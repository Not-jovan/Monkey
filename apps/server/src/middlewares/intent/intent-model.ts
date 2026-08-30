import { z } from "zod";

export const intentStateSchema = z.object({
  // What the agent was actually told to do. `agent.instructions` is written to
  // the workspace's AGENTS.md and is the spec the agent follows, so it is the
  // source of truth here too — mirrored rather than re-derived.
  instructions: z.string().default(""),
  objective: z.string(),
  extended: z.array(z.string()),
});

export type IntentState = z.infer<typeof intentStateSchema>;

export const emptyIntent = (): IntentState => ({
  instructions: "",
  objective: "",
  extended: [],
});

export function intentIsEmpty(state: IntentState) {
  return state.objective.length === 0 && state.extended.length === 0;
}

// The auditor is a separate agent with its own spec. When it is the one being
// judged, that spec is the job it was given — not the target agent's.
export const AUDITOR_OBJECTIVE = "Audit the target agent.";

// Constraint text is round-tripped through a model, so an exact-string match
// would let a stray capital or full stop keep a lifted rule in force.
export function sameConstraint(left: string, right: string) {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/[.\s]+$/, "");
  return normalize(left) === normalize(right) && normalize(left).length > 0;
}

// Whether the working objective has moved away from the instructions the agent
// is following. Derived, never stored: a persisted flag would be a third thing
// that can fall out of step with the two it describes, which is the whole bug.
//
// An empty `instructions` means the record predates this field, or the agent
// was never configured. Neither is a divergence.
export function hasDivergedObjective(state: {
  instructions: string;
  objective: string;
}) {
  return (
    state.instructions.length > 0 && state.objective !== state.instructions
  );
}

// Why a version exists, in fields rather than prose.
//
// `logs` already carried the triggering message, the classifier's reason and
// each added constraint — but only as sentences glued together, which no UI
// could show as a diff. Everything below is optional so intent files written
// before the timeline existed still parse.
export const intentUpdateSchema = z.object({
  logs: z.array(z.string()),
  kind: z.enum(["seed", "classified"]).default("classified"),
  // The user message that changed the spec.
  message: z.string().optional(),
  // The classifier's own justification.
  reason: z.string().optional(),
  addedConstraints: z.array(z.string()).default([]),
  // Constraints this version lifted. A spec that can only grow cannot record
  // the user taking a rule back.
  removedConstraints: z.array(z.string()).default([]),
  previousObjective: z.string().nullable().default(null),
  // The run this message belonged to, so the Playground can mark the message
  // that moved the spec.
  traceId: z.string().nullable().default(null),
  // Set when this version restores an earlier one.
  revertedFrom: z.string().nullable().default(null),
  // A human correction is evidence-backed: these fields lead back to the
  // audit finding and step the operator reviewed before changing the spec.
  sourceFindingId: z.string().nullable().optional(),
  sourceSpanId: z.string().nullable().optional(),
});

export type IntentUpdate = z.infer<typeof intentUpdateSchema>;

export const intentVersionSchema = z.object({
  // What agent.instructions said when this version was written — the spec the
  // agent was actually following, mirrored here so the record shows that and
  // not only what the auditor was judging against. Defaulted so intent files
  // written before this field existed still parse, and read as not diverged.
  instructions: z.string().default(""),
  objective: z.string(),
  extended: z.array(z.string()),
  createdAt: z.string().optional(),
  update: intentUpdateSchema.optional(),
});

export type IntentVersion = z.infer<typeof intentVersionSchema>;

// The ordered form the API serves. History is append-only, so position in this
// list is the version number a reader sees.
export interface IntentVersionEntry extends IntentVersion {
  id: string;
}

export const intentFileSchema = z.record(z.string(), intentVersionSchema);

// What one audit's identifier phase produced. Stored on the chat audit, not in
// a standing store: the next audit rebases from this plus current instructions.
export const intentDerivationSchema = z.object({
  state: intentStateSchema,
  addedConstraints: z.array(z.string()).default([]),
  removedConstraints: z.array(z.string()).default([]),
  previousObjective: z.string().nullable().default(null),
  reason: z.string().default(""),
  message: z.string().nullable().default(null),
  kind: z.enum(["seed", "classified"]).default("classified"),
});

export type IntentDerivation = z.infer<typeof intentDerivationSchema>;

export function describeIntent(state: IntentState) {
  const lines: string[] = [];
  if (state.instructions.length > 0) {
    lines.push("Agent instructions: " + state.instructions);
  }
  lines.push("Objective: " + (state.objective || "(none stated)"));
  // Said plainly rather than left for the auditor to infer from two similar
  // paragraphs: the objective below is what the conversation moved to, and the
  // instructions above are what the agent is still configured with.
  if (hasDivergedObjective(state)) {
    lines.push(
      "(The objective above came from the conversation and has not been " +
        "adopted into the agent's instructions. Judge against the objective.)",
    );
  }
  if (state.extended.length > 0) {
    lines.push("Standing constraints:");
    for (const entry of state.extended) lines.push("- " + entry);
  }
  return lines.join("\n");
}
