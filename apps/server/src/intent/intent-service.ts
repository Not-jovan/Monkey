import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import { hasDivergedObjective, type IntentState } from "./intent-model.js";
import type { IntentStore } from "./intent-store.js";

export interface ClassifyFailure {
  agentId: string;
  // Null for a message that arrived without a run to attach the report to.
  traceId: string | null;
  attempts: number;
  failure: string;
}

interface IntentServiceDeps {
  store: IntentStore;
  client: ArkClient;
  model: string;
  enabled: boolean;
  // Reports a message whose classification never produced a verdict. A log
  // line is not enough: the user believes the rule they just stated is in
  // force, and without a finding nothing anywhere says it never landed.
  onClassifyFailed?: (failure: ClassifyFailure) => void;
  log?: (message: string, error?: unknown) => void;
}

export interface IntentObserveInput {
  content: string;
  // Optional because our caller does not send it: main declares it and its
  // tests pass it, but nothing reads it yet.
  messageId?: string;
  // The run this message opened. Known before the run starts, so the version
  // this message produces can be traced back to it.
  traceId: string;
}

// Constraint text is round-tripped through a model, so an exact-string match
// would let a stray capital or full stop keep a lifted rule in force.
function sameConstraint(left: string, right: string) {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/[.\s]+$/, "");
  return normalize(left) === normalize(right) && normalize(left).length > 0;
}

export interface HumanCorrectionInput {
  correction: string;
  traceId: string;
  findingId: string;
  spanId: string | null;
}

export class IntentService {
  private chain = Promise.resolve();
  private readonly forgotten = new Set<string>();

  constructor(private readonly deps: IntentServiceDeps) {}

  idle() {
    return this.chain;
  }

  state(agentId: string): IntentState {
    const latest = this.deps.store.latest(agentId);
    if (!latest) return { instructions: "", objective: "", extended: [] };
    return {
      instructions: latest.version.instructions,
      objective: latest.version.objective,
      extended: [...latest.version.extended],
    };
  }

  currentId(agentId: string) {
    return this.deps.store.latest(agentId)?.intentId ?? "";
  }

  // The spec this run was judged against, not whatever the agent has now.
  forTrace(agentId: string, intentId: string | null) {
    const pinnedId = intentId && intentId.length > 0 ? intentId : null;
    const latest = this.deps.store.latest(agentId);
    const pinned = pinnedId ? this.deps.store.get(agentId, pinnedId) : null;
    const entry = pinned
      ? pinned
      : latest
        ? { id: latest.intentId, ...latest.version }
        : null;
    if (!entry) return null;
    return {
      id: entry.id,
      objective: entry.objective,
      extended: [...entry.extended],
      stale: latest !== null && entry.id !== latest.intentId,
    };
  }

  view(agentId: string) {
    const latest = this.deps.store.latest(agentId);
    return {
      intent: this.state(agentId),
      diverged: hasDivergedObjective(this.state(agentId)),
      // Ordered list, not a record: version order is insertion order and the
      // ids are random UUIDs, so it has to be carried explicitly.
      versions: this.deps.store.list(agentId),
      intentId: latest?.intentId ?? null,
    };
  }

  // Appends a version restoring an earlier one. Returns the new view so the
  // caller does not have to re-read.
  revert(agentId: string, intentId: string) {
    const created = this.deps.store.revert(agentId, intentId);
    return { created, view: this.view(agentId) };
  }

  applyHumanCorrection(agentId: string, input: HumanCorrectionInput) {
    const correction = input.correction.trim();
    const view = this.view(agentId);
    if (!this.canApplyHumanCorrection(agentId, input.findingId, correction)) {
      return { created: null, view };
    }
    const created = this.deps.store.append(agentId, {
      // A correction changes the standing constraints, never the instructions
      // the agent reads — rewriting AGENTS.md is a separate, human action.
      instructions: view.intent.instructions,
      objective: view.intent.objective,
      extended: [...view.intent.extended, correction],
      update: {
        kind: "human-correction",
        // Ours added removal support to the update record; a correction only
        // ever adds, so it declares an empty list rather than omitting it.
        removedConstraints: [],
        logs: [
          "Human correction applied from audit finding " + input.findingId,
          "Added constraint: " + correction,
        ],
        message: correction,
        reason: "Applied by a human after reviewing Glass Box evidence.",
        addedConstraints: [correction],
        previousObjective: null,
        traceId: input.traceId,
        revertedFrom: null,
        sourceFindingId: input.findingId,
        sourceSpanId: input.spanId,
      },
    });
    return { created, view: this.view(agentId) };
  }

  canApplyHumanCorrection(
    agentId: string,
    findingId: string,
    correction: string,
  ) {
    const view = this.view(agentId);
    return (
      !this.forgotten.has(agentId) &&
      correction.trim().length > 0 &&
      !view.intent.extended.includes(correction.trim()) &&
      !view.versions.some(
        (entry) => entry.update?.sourceFindingId === findingId,
      )
    );
  }

  forget(agentId: string) {
    this.forgotten.add(agentId);
    this.deps.store.remove(agentId);
  }

  seed(agentId: string, instructions: string) {
    if (this.forgotten.has(agentId)) return;
    const trimmed = instructions.trim();
    this.deps.store.seed(agentId, trimmed, trimmed);
  }

  // Mirrors an edit to the agent's instructions. Idempotent, so the PATCH that
  // renames an agent does not append a version.
  syncInstructions(
    agentId: string,
    instructions: string,
    kind: "instructions" | "adopted" = "instructions",
  ) {
    return this.deps.store.syncInstructions(agentId, instructions.trim(), kind);
  }

  // The objective to write back into the agent's instructions, or null when
  // there is nothing to adopt.
  pendingAdoption(agentId: string) {
    const state = this.state(agentId);
    return hasDivergedObjective(state) ? state.objective : null;
  }

  observe(agentId: string, instructions: string, input: IntentObserveInput) {
    if (this.forgotten.has(agentId)) return;
    const message = input.content.trim();
    const trimmedInstructions = instructions.trim();
    const existing = this.deps.store.latest(agentId);
    if (!existing || existing.version.objective.length === 0) {
      // Instructions first: they are what the agent actually follows. Only an
      // agent configured with none falls back to the opening message, which is
      // then the best statement of the goal available.
      this.deps.store.seed(
        agentId,
        trimmedInstructions || message,
        trimmedInstructions,
      );
      return;
    }
    if (!this.deps.enabled) return;
    // The trace id was already being handed over and thrown away. Carrying it
    // is what lets the Playground mark the message that moved the spec.
    this.enqueue(() => this.classify(agentId, message, input.traceId));
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain
      .then(task)
      .catch((error) => this.deps.log?.("intent classification failed", error));
  }

  private async classify(agentId: string, message: string, traceId?: string) {
    if (this.forgotten.has(agentId)) return;
    const state = this.state(agentId);
    const result = await classifyIntent(
      this.deps.client,
      this.deps.model,
      state,
      message,
    );
    if (!result.classification) {
      const failure = result.failure ?? "unknown";
      this.deps.log?.(
        "intent classifier gave up after " +
          result.attempts +
          " attempts: " +
          failure,
      );
      this.deps.onClassifyFailed?.({
        agentId,
        traceId: traceId ?? null,
        attempts: result.attempts,
        failure,
      });
      return;
    }
    // The model call can finish after Agent deletion. Do not recreate the
    // in-memory or persisted intent that forget() just removed.
    if (this.forgotten.has(agentId)) return;
    const { classification, reason, extendedIntent, removedIntent, objective } =
      result.classification;
    if (classification === "NO_CHANGE") return;

    // Rebase onto whatever the spec is *now*, not onto the snapshot this call
    // started from. The model call above can take seconds, and a revert during
    // that window would otherwise be silently undone: the append would rebuild
    // `extended` from the pre-revert state and resurrect the constraint the
    // user had just removed.
    const current = this.state(agentId);

    // A relaxation names a rule already in force. Matched loosely on purpose:
    // the model is asked to copy the constraint verbatim, and a difference of
    // case or trailing punctuation should not leave the rule standing.
    const removed = current.extended.filter((entry) =>
      removedIntent.some((candidate) => sameConstraint(candidate, entry)),
    );
    const kept = current.extended.filter((entry) => !removed.includes(entry));

    const added = extendedIntent
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !kept.includes(entry));
    const nextObjective =
      objective !== null &&
      objective.trim().length > 0 &&
      objective.trim() !== current.objective
        ? objective.trim()
        : null;
    if (added.length === 0 && removed.length === 0 && !nextObjective) return;

    const logs = [message, reason];
    if (nextObjective) {
      logs.push(
        "Objective changed from " + current.objective + " to " + nextObjective,
      );
    }
    for (const entry of added) {
      logs.push("Added constraint: " + entry);
    }
    for (const entry of removed) {
      logs.push("Removed constraint: " + entry);
    }
    this.deps.store.append(agentId, {
      // Carried through untouched. A conversational pivot layers on top of the
      // instructions rather than rewriting them: the agent keeps following what
      // it was configured with until someone adopts the new objective, and the
      // gap between the two is what the UI surfaces as a divergence.
      instructions: current.instructions,
      objective: nextObjective ?? current.objective,
      extended: [...kept, ...added],
      update: {
        kind: "classified",
        logs,
        message,
        reason,
        addedConstraints: added,
        removedConstraints: removed,
        previousObjective: nextObjective ? current.objective : null,
        traceId: traceId ?? null,
        revertedFrom: null,
      },
    });
  }
}
