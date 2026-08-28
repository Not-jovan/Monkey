import { z } from "zod";

export const intentStateSchema = z.object({
  objective: z.string(),
  extended: z.array(z.string()),
});

export type IntentState = z.infer<typeof intentStateSchema>;

export const intentVersionSchema = z.object({
  objective: z.string(),
  extended: z.array(z.string()),
  update: z.object({ logs: z.array(z.string()) }).optional(),
});

export type IntentVersion = z.infer<typeof intentVersionSchema>;

export const intentFileSchema = z.record(z.string(), intentVersionSchema);

export function describeIntent(state: IntentState) {
  const lines = ["Objective: " + (state.objective || "(none stated)")];
  if (state.extended.length > 0) {
    lines.push("Standing constraints:");
    for (const entry of state.extended) lines.push("- " + entry);
  }
  return lines.join("\n");
}
