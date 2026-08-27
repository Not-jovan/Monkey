import { randomUUID } from "node:crypto";
import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import {
  toIntentState,
  type IntentRecord,
  type IntentState,
  type IntentUpdate,
} from "./intent-model.js";
import type { IntentStore } from "./intent-store.js";

interface IntentServiceDeps {
  store: IntentStore;
  client: ArkClient;
  model: string;
  enabled: boolean;
  // Phase 4 flips this on: updates land as "pending" and wait for the user to
  // confirm instead of taking effect immediately.
  requireConfirmation?: boolean;
  log?: (message: string, error?: unknown) => void;
  now?: () => Date;
}

// Maintains the specification each agent is judged against. Classification is
// queued rather than awaited so a slow or unreachable model never delays a
// user's message; the state lands well before the first step audit needs it.
export class IntentService {
  private chain = Promise.resolve();

  constructor(private readonly deps: IntentServiceDeps) {}

  // Tests await this to observe queued classifications without polling.
  idle() {
    return this.chain;
  }

  state(agentId: string): IntentState {
    return toIntentState(this.deps.store.get(agentId));
  }

  record(agentId: string): IntentRecord | null {
    return this.deps.store.get(agentId);
  }

  forget(agentId: string) {
    this.deps.store.remove(agentId);
  }

  // The whiteboard's "prompt user to confirm update of intent". Classification
  // is asynchronous, so the prompt reaches the user just after their message
  // rather than blocking it; nothing takes effect until they decide.
  pending(agentId: string) {
    return this.deps.store.pending(agentId);
  }

  resolve(agentId: string, updateId: string, decision: "confirm" | "reject") {
    return this.deps.store.resolve(agentId, updateId, decision);
  }

  requiresConfirmation() {
    return this.deps.requireConfirmation === true;
  }

  // The agent's instructions are the original intent. When there are none, the
  // first message the user sends becomes the objective instead of being
  // classified against an empty specification.
  seed(agentId: string, instructions: string) {
    this.deps.store.ensure(agentId, instructions.trim());
  }

  observe(agentId: string, instructions: string, message: string) {
    const existing = this.deps.store.ensure(agentId, instructions.trim());
    if (existing.objective.length === 0) {
      this.deps.store.ensure(agentId, message.trim());
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
    const objectiveChanged =
      objective !== null &&
      objective.trim().length > 0 &&
      objective.trim() !== state.objective;
    if (added.length === 0 && !objectiveChanged) return;

    const update: IntentUpdate = {
      id: randomUUID(),
      at: (this.deps.now?.() ?? new Date()).toISOString(),
      message,
      reason,
      added,
      objectiveBefore: objectiveChanged ? state.objective : null,
      objectiveAfter: objectiveChanged ? objective.trim() : null,
      status: this.deps.requireConfirmation ? "pending" : "applied",
    };
    this.deps.store.apply(agentId, update);
  }
}
