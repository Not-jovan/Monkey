import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import type { IntentStore } from "./intent-store.js";

interface IntentServiceDeps {
  store: IntentStore;
  client: ArkClient;
  model: string;
  enabled: boolean;
  log?: (message: string, error?: unknown) => void;
}

export interface IntentObserveInput {
  content: string;
  messageId: string;
  traceId: string;
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

  state(agentId: string) {
    const latest = this.deps.store.latest(agentId);
    if (!latest) return { objective: "", extended: [] };
    return {
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
      intent: latest
        ? {
            objective: latest.version.objective,
            extended: [...latest.version.extended],
          }
        : { objective: "", extended: [] },
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
      objective: view.intent.objective,
      extended: [...view.intent.extended, correction],
      update: {
        kind: "human-correction",
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
    this.deps.store.seed(agentId, instructions.trim());
  }

  observe(agentId: string, instructions: string, input: IntentObserveInput) {
    if (this.forgotten.has(agentId)) return;
    const trimmedInstructions = instructions.trim();
    const message = input.content.trim();
    if (trimmedInstructions.length > 0) {
      this.deps.store.seed(agentId, trimmedInstructions);
    }
    const existing = this.deps.store.latest(agentId);
    if (!existing || existing.version.objective.length === 0) {
      this.deps.store.seed(agentId, message);
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
      this.deps.log?.(
        "intent classifier gave up after " +
          result.attempts +
          " attempts: " +
          (result.failure ?? "unknown"),
      );
      return;
    }
    // The model call can finish after Agent deletion. Do not recreate the
    // in-memory or persisted intent that forget() just removed.
    if (this.forgotten.has(agentId)) return;
    const { classification, reason, extendedIntent, objective } =
      result.classification;
    if (classification === "NO_CHANGE") return;

    // Rebase onto whatever the spec is *now*, not onto the snapshot this call
    // started from. The model call above can take seconds, and a revert during
    // that window would otherwise be silently undone: the append would rebuild
    // `extended` from the pre-revert state and resurrect the constraint the
    // user had just removed.
    const current = this.state(agentId);

    const added = extendedIntent
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !current.extended.includes(entry));
    const nextObjective =
      objective !== null &&
      objective.trim().length > 0 &&
      objective.trim() !== current.objective
        ? objective.trim()
        : null;
    if (added.length === 0 && !nextObjective) return;

    const logs = [message, reason];
    if (nextObjective) {
      logs.push(
        "Objective changed from " + current.objective + " to " + nextObjective,
      );
    }
    for (const entry of added) {
      logs.push("Added constraint: " + entry);
    }
    this.deps.store.append(agentId, {
      objective: nextObjective ?? current.objective,
      extended: [...current.extended, ...added],
      update: {
        kind: "classified",
        logs,
        message,
        reason,
        addedConstraints: added,
        previousObjective: nextObjective ? current.objective : null,
        traceId: traceId ?? null,
        revertedFrom: null,
      },
    });
  }
}
