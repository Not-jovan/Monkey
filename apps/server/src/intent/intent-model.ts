import { randomUUID } from "node:crypto";

// The specification an agent's future actions are judged against. The original
// instruction is the objective; everything the user adds mid-thread lands in
// `extended` and stays in force for the rest of the conversation.
export interface IntentState {
  objective: string;
  extended: string[];
}

// The user message (chat) and the run/trace it started. One send is one chat.
export interface IntentChatRef {
  messageId: string;
  traceId: string;
}

export type IntentUpdateStatus = "applied" | "pending" | "rejected";

export interface IntentUpdate {
  id: string;
  at: string;
  // The message that changed the specification, kept so an operator can see
  // why a constraint exists.
  message: string;
  messageId: string | null;
  traceId: string | null;
  reason: string;
  added: string[];
  objectiveBefore: string | null;
  objectiveAfter: string | null;
  status: IntentUpdateStatus;
}

// A frozen copy of the spec after a change, plus every run that proceeded
// under it. Audits ignore this and read the latest objective/extended;
// tracing uses it to recover which spec a given chat ran against.
export interface IntentSnapshot {
  id: string;
  at: string;
  objective: string;
  extended: string[];
  lastModifiedBy: IntentChatRef | null;
  traces: string[];
}

export interface IntentRecord {
  version: 1;
  agentId: string;
  objective: string;
  extended: string[];
  updatedAt: string;
  lastModifiedBy: IntentChatRef | null;
  states: IntentSnapshot[];
  history: IntentUpdate[];
}

export function createSnapshot(input: {
  objective: string;
  extended: string[];
  lastModifiedBy: IntentChatRef | null;
  traces: string[];
  at?: string;
}): IntentSnapshot {
  return {
    id: randomUUID(),
    at: input.at ?? new Date().toISOString(),
    objective: input.objective,
    extended: [...input.extended],
    lastModifiedBy: input.lastModifiedBy,
    traces: [...input.traces],
  };
}

export const emptyIntent = (agentId: string, objective: string): IntentRecord => {
  const at = new Date().toISOString();
  return {
    version: 1,
    agentId,
    objective,
    extended: [],
    updatedAt: at,
    lastModifiedBy: null,
    states: [
      createSnapshot({
        objective,
        extended: [],
        lastModifiedBy: null,
        traces: [],
        at,
      }),
    ],
    history: [],
  };
};

export function toIntentState(record: IntentRecord | null): IntentState {
  return {
    objective: record?.objective ?? "",
    extended: record ? [...record.extended] : [],
  };
}

export function snapshotForTrace(
  record: IntentRecord | null,
  traceId: string,
): IntentSnapshot | null {
  if (!record || record.states.length === 0) return null;
  const match = record.states.find((entry) => entry.traces.includes(traceId));
  return match ?? record.states[record.states.length - 1] ?? null;
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
