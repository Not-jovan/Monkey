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

export class IntentService {
  private chain = Promise.resolve();

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

  view(agentId: string) {
    const versions = this.deps.store.get(agentId);
    const latest = this.deps.store.latest(agentId);
    return {
      intent: latest
        ? {
            objective: latest.version.objective,
            extended: [...latest.version.extended],
          }
        : { objective: "", extended: [] },
      versions: versions ? Object.fromEntries(versions) : {},
      intentId: latest?.intentId ?? null,
    };
  }

  forget(agentId: string) {
    this.deps.store.remove(agentId);
  }

  seed(agentId: string, instructions: string) {
    this.deps.store.seed(agentId, instructions.trim());
  }

  observe(agentId: string, instructions: string, input: IntentObserveInput) {
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
    this.enqueue(() => this.classify(agentId, message));
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain
      .then(task)
      .catch((error) => this.deps.log?.("intent classification failed", error));
  }

  private async classify(agentId: string, message: string) {
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
    const { classification, reason, extendedIntent, objective } =
      result.classification;
    if (classification === "NO_CHANGE") return;

    const added = extendedIntent
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !state.extended.includes(entry));
    const nextObjective =
      objective !== null &&
      objective.trim().length > 0 &&
      objective.trim() !== state.objective
        ? objective.trim()
        : null;
    if (added.length === 0 && !nextObjective) return;

    const logs = [message, reason];
    if (nextObjective) {
      logs.push(
        "Objective changed from " + state.objective + " to " + nextObjective,
      );
    }
    for (const entry of added) {
      logs.push("Added constraint: " + entry);
    }
    this.deps.store.append(agentId, {
      objective: nextObjective ?? state.objective,
      extended: [...state.extended, ...added],
      update: { logs },
    });
  }
}
