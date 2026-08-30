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
    this.recordMissedRuns();
  }

  // A run interrupted by a restart is rewritten from running to failed by
  // TraceStore.initialize, directly on the record rather than through
  // updateTrace, so no trace-completed is ever emitted for it — and the
  // subscription above is installed after that rewrite has already happened.
  // Without this sweep such a run has no context record and never will: the
  // only writer is an event that already did not fire.
  //
  // That matters more than one missing entry. chainFor anchors on the record
  // for the trace it is asked about and returns nothing when there is none, so
  // a hole does not get stepped over — it cuts the continuity the chain exists
  // to provide, for the run itself and for the session it belonged to.
  //
  // Unbounded, unlike the audit's equivalent sweep: recording a run's context
  // reads the trace already in memory and costs no model call, and after the
  // first boot the only candidates are runs that actually crashed.
  private recordMissedRuns() {
    for (const trace of this.deps.traceStore.list()) {
      if (trace.status === "running") continue;
      if (this.deps.store.get(trace.id)) continue;
      this.deps.store.record(trace);
    }
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
