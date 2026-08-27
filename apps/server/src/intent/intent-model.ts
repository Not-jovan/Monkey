// The specification an agent's future actions are judged against. The original
// instruction is the objective; everything the user adds mid-thread lands in
// `extended` and stays in force for the rest of the conversation.
export interface IntentState {
  objective: string;
  extended: string[];
}

export type IntentUpdateStatus = "applied" | "pending" | "rejected";

export interface IntentUpdate {
  id: string;
  at: string;
  // The message that changed the specification, kept so an operator can see
  // why a constraint exists.
  message: string;
  reason: string;
  added: string[];
  objectiveBefore: string | null;
  objectiveAfter: string | null;
  status: IntentUpdateStatus;
}

export interface IntentRecord {
  version: 1;
  agentId: string;
  objective: string;
  extended: string[];
  updatedAt: string;
  history: IntentUpdate[];
}

export const emptyIntent = (agentId: string, objective: string): IntentRecord => ({
  version: 1,
  agentId,
  objective,
  extended: [],
  updatedAt: new Date().toISOString(),
  history: [],
});

export function toIntentState(record: IntentRecord | null): IntentState {
  return {
    objective: record?.objective ?? "",
    extended: record ? [...record.extended] : [],
  };
}

// Rendered into audit prompts so a step is judged against the whole
// specification, not just the objective it started from.
export function describeIntent(state: IntentState): string {
  const lines = ["Objective: " + (state.objective || "(none stated)")];
  if (state.extended.length > 0) {
    lines.push("Standing constraints:");
    for (const entry of state.extended) lines.push("- " + entry);
  }
  return lines.join("\n");
}
