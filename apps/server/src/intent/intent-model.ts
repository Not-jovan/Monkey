import { z } from "zod";

export const intentStateSchema = z.object({
  objective: z.string(),
  extended: z.array(z.string()),
});

export type IntentState = z.infer<typeof intentStateSchema>;

// Why a version exists, in fields rather than prose.
//
// `logs` already carried the triggering message, the classifier's reason and
// each added constraint — but only as sentences glued together, which no UI
// could show as a diff. Everything below is optional so intent files written
// before the timeline existed still parse.
export const intentUpdateSchema = z.object({
  logs: z.array(z.string()),
  kind: z.enum(["seed", "classified", "revert"]).default("classified"),
  // The user message that changed the spec.
  message: z.string().optional(),
  // The classifier's own justification.
  reason: z.string().optional(),
  addedConstraints: z.array(z.string()).default([]),
  previousObjective: z.string().nullable().default(null),
  // The run this message belonged to, so the Playground can mark the message
  // that moved the spec.
  traceId: z.string().nullable().default(null),
  // Set when this version restores an earlier one.
  revertedFrom: z.string().nullable().default(null),
});

export type IntentUpdate = z.infer<typeof intentUpdateSchema>;

export const intentVersionSchema = z.object({
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

export function describeIntent(state: IntentState) {
  const lines = ["Objective: " + (state.objective || "(none stated)")];
  if (state.extended.length > 0) {
    lines.push("Standing constraints:");
    for (const entry of state.extended) lines.push("- " + entry);
  }
  return lines.join("\n");
}
