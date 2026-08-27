import { randomUUID } from "node:crypto";
import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import {
  snapshotForTrace,
  toIntentState,
  type IntentChatRef,
  type IntentRecord,
  type IntentSnapshot,
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
}

export interface IntentObserveInput {
  content: string;
  messageId: string;
  traceId: string;
}

// Maintains the specification each agent is judged against. Classification is
// queued from POST /api/agents/:id/messages so a slow model never delays the
// run; the state lands well before the first step audit needs it.
export class IntentService {
  private chain = Promise.resolve();

  constructor(private readonly deps: IntentServiceDeps) {}

  // Tests await this to observe queued classifications without polling.
  idle() {
    return this.chain;
  }

  // Audits always read this: the latest spec, not the snapshot a past chat ran
  // under.
  state(agentId: string): IntentState {
    return toIntentState(this.deps.store.get(agentId));
  }

  record(agentId: string): IntentRecord | null {
    return this.deps.store.get(agentId);
  }

  snapshotForTrace(agentId: string, traceId: string): IntentSnapshot | null {
    return snapshotForTrace(this.deps.store.get(agentId), traceId);
  }

  forget(agentId: string) {
    this.deps.store.remove(agentId);
  }

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

  observe(agentId: string, instructions: string, input: IntentObserveInput) {
    const chat: IntentChatRef = {
      messageId: input.messageId,
      traceId: input.traceId,
    };
    const trimmedInstructions = instructions.trim();
    const message = input.content.trim();
    if (trimmedInstructions.length > 0) {
      this.deps.store.ensure(agentId, trimmedInstructions);
    }
    const existing = this.deps.store.get(agentId);
    if (!existing || existing.objective.length === 0) {
      this.deps.store.ensure(agentId, message, chat);
      return;
    }
    this.deps.store.noteChat(agentId, chat);
    if (!this.deps.enabled) return;
    this.enqueue(() => this.classify(agentId, message, chat));
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain
      .then(task)
      .catch((error) => this.deps.log?.("intent classification failed", error));
  }

  private async classify(
    agentId: string,
    message: string,
    chat: IntentChatRef,
  ) {
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
      at: new Date().toISOString(),
      message,
      messageId: chat.messageId,
      traceId: chat.traceId,
      reason,
      added,
      objectiveBefore: objectiveChanged ? state.objective : null,
      objectiveAfter: objectiveChanged ? objective.trim() : null,
      status: this.deps.requireConfirmation ? "pending" : "applied",
    };
    this.deps.store.apply(agentId, update);
  }
}
