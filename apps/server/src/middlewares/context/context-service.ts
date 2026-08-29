import type { TraceStore } from "../trace/trace-store.js";
import type { ContextStore } from "./context-store.js";
import type { RunContext } from "./context-model.js";

export interface ContextView {
  // The nearest earlier run on this thread, and what it left behind.
  carriedIn: RunContext | null;
  // What this run leaves for the next one.
  carriedOut: RunContext | null;
  // Position on the Codex thread, so the UI can say "run 3 of 5".
  position: number;
  chainLength: number;
  previousTraceId: string | null;
  nextTraceId: string | null;
}

const emptyView: ContextView = {
  carriedIn: null,
  carriedOut: null,
  position: 0,
  chainLength: 0,
  previousTraceId: null,
  nextTraceId: null,
};

interface ContextServiceDeps {
  traceStore: TraceStore;
  store: ContextStore;
}

// Records what every run leaves behind, whatever the auditor is doing.
//
// It subscribes to the same `trace-completed` event the auditor does, but
// writes synchronously and without a model, so the chain is established before
// anything that can fail has been attempted.
export class ContextService {
  constructor(private readonly deps: ContextServiceDeps) {}

  start() {
    this.deps.traceStore.on("trace-completed", ({ trace }) => {
      this.deps.store.record(trace);
    });
  }

  forget(agentId: string) {
    this.deps.store.forgetAgent(agentId);
  }

  view(traceId: string): ContextView {
    const chain = this.deps.store.chainFor(traceId);
    const index = chain.findIndex((entry) => entry.traceId === traceId);
    if (index === -1) return emptyView;
    return {
      carriedIn: index > 0 ? (chain[index - 1] ?? null) : null,
      carriedOut: chain[index] ?? null,
      position: index + 1,
      chainLength: chain.length,
      previousTraceId: index > 0 ? (chain[index - 1]?.traceId ?? null) : null,
      nextTraceId: chain[index + 1]?.traceId ?? null,
    };
  }
}
