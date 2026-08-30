import type { IntentClassification } from "./intent-classifier.js";
import {
  sameConstraint,
  type IntentDerivation,
  type IntentState,
} from "./intent-model.js";

export interface ReduceInput {
  // What the agent is configured with right now. Always the base of a
  // derivation — a standing store of classified rules used to drift away from
  // this and then get judged as if it were still in force.
  instructions: string;
  // The last audit's derivation for this same agent, if any.
  prior: IntentState | null;
  // The user message (or auditor prompt) this pass is reducing.
  message: string;
}

export type IntentClassify = (
  state: IntentState,
  message: string,
) => Promise<IntentClassification | null>;

// Folds current instructions, the previous audit's spec, and this run's
// message into the spec this audit will judge against.
export class IntentReducer {
  constructor(private readonly classify: IntentClassify) {}

  async reduce(input: ReduceInput): Promise<IntentDerivation> {
    const base = rebase(input.instructions, input.prior);
    const message = input.message.trim();
    if (message.length === 0) {
      return {
        state: base,
        addedConstraints: [],
        removedConstraints: [],
        previousObjective: null,
        reason: input.prior ? "No new message to reduce." : "Seeded from instructions.",
        message: null,
        kind: input.prior ? "classified" : "seed",
      };
    }

    const verdict = await this.classify(base, message);
    if (!verdict || verdict.classification === "NO_CHANGE") {
      return {
        state: base,
        addedConstraints: [],
        removedConstraints: [],
        previousObjective: null,
        reason: verdict?.reason ?? "No specification change in this message.",
        message,
        kind: input.prior ? "classified" : "seed",
      };
    }

    return applyUpdate(base, verdict, message);
  }
}

// Current instructions win as the mirrored field. An objective that was still
// tracking the previous instructions follows the edit; one the conversation
// had already moved stays where it is until this message says otherwise.
export function rebase(
  instructions: string,
  prior: IntentState | null,
): IntentState {
  const trimmed = instructions.trim();
  if (!prior) {
    return {
      instructions: trimmed,
      objective: trimmed,
      extended: [],
    };
  }
  const wasInSync =
    prior.instructions.length === 0 || prior.objective === prior.instructions;
  return {
    instructions: trimmed,
    objective: wasInSync && trimmed.length > 0 ? trimmed : prior.objective,
    extended: [...prior.extended],
  };
}

function applyUpdate(
  base: IntentState,
  verdict: IntentClassification,
  message: string,
): IntentDerivation {
  const removed = base.extended.filter((entry) =>
    verdict.removedIntent.some((candidate) => sameConstraint(candidate, entry)),
  );
  const kept = base.extended.filter((entry) => !removed.includes(entry));
  const added = verdict.extendedIntent
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !kept.includes(entry));
  const nextObjective =
    verdict.objective !== null &&
    verdict.objective.trim().length > 0 &&
    verdict.objective.trim() !== base.objective
      ? verdict.objective.trim()
      : null;
  if (added.length === 0 && removed.length === 0 && !nextObjective) {
    return {
      state: base,
      addedConstraints: [],
      removedConstraints: [],
      previousObjective: null,
      reason: verdict.reason,
      message,
      kind: "classified",
    };
  }
  return {
    state: {
      instructions: base.instructions,
      objective: nextObjective ?? base.objective,
      extended: [...kept, ...added],
    },
    addedConstraints: added,
    removedConstraints: removed,
    previousObjective: nextObjective ? base.objective : null,
    reason: verdict.reason,
    message,
    kind: "classified",
  };
}
