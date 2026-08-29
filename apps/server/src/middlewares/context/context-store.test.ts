import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyUsage, type TraceRecord } from "../trace/trace-model.js";
import { TraceStore } from "../trace/trace-store.js";
import { ContextService } from "./context-service.js";
import { ContextStore } from "./context-store.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeStores() {
  const directory = await mkdtemp(path.join(tmpdir(), "context-store-"));
  const traceStore = new TraceStore(path.join(directory, "traces"));
  await traceStore.initialize();
  const store = new ContextStore(path.join(directory, "context"));
  await store.initialize();
  const service = new ContextService({ traceStore, store });
  service.start();
  cleanups.push(async () => {
    await traceStore.flush();
    await store.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return { traceStore, store, service, directory };
}

function trace(
  id: string,
  overrides: Partial<TraceRecord> = {},
): TraceRecord {
  return {
    version: 1,
    id,
    agentId: "agent-1",
    conversationId: "thread-1",
    status: "running",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: null,
    prompt: "count files",
    model: null,
    usage: emptyUsage(),
    failingSpanId: null,
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    spans: [],
    ...overrides,
  };
}

// Creates the trace as running and then closes it, because trace-completed only
// fires on the running -> finished transition. Seeding a trace that is already
// finished emits nothing, which is correct behaviour and an easy trap in tests.
function complete(
  traceStore: TraceStore,
  id: string,
  overrides: Partial<TraceRecord> = {},
) {
  const { status, endedAt, ...rest } = overrides;
  traceStore.create(trace(id, rest));
  traceStore.updateTrace(id, (record) => {
    record.status = status ?? "completed";
    record.endedAt = endedAt ?? "2026-08-26T12:00:10.000Z";
  });
}

describe("ContextStore", () => {
  // The whole point of the rewrite: this used to require a successful model
  // call, so an unactivated audit endpoint left every later run with no idea
  // what came before it.
  it("establishes prior context with no model involved at all", async () => {
    const { traceStore, store } = await makeStores();

    complete(traceStore, "run-1", { prompt: "write the docs" });
    complete(traceStore, "run-2", {
      startedAt: "2026-08-26T12:01:00.000Z",
      endedAt: "2026-08-26T12:01:30.000Z",
    });

    const carried = store.priorFor("run-2");
    expect(carried?.traceId).toBe("run-1");
    expect(carried?.source).toBe("derived");
    expect(carried?.summary).toContain("write the docs");
    expect(carried?.summary).toContain("completed");
  });

  it("carries a failed run's attribution forward", async () => {
    const { traceStore, store } = await makeStores();

    complete(traceStore, "run-1", {
      status: "failed",
      failure: {
        layer: "policy",
        kind: "sandbox-denied",
        retryability: "user-action",
        title: "The Runtime sandbox denied this operation",
        detail: "listen EPERM 0.0.0.0:8080",
        remedy: "Keep the work inside /workspace.",
        exitCode: 1,
      },
    });

    const digest = store.get("run-1");
    expect(digest?.digest.failureKind).toBe("sandbox-denied");
    expect(digest?.summary).toContain("policy · sandbox-denied");
  });

  // "Outcome: completed (sandbox-denied)" reads as a contradiction. The next
  // run's auditor reads this text, so the wording has to carry the distinction.
  it("words a recovered failure apart from one that stopped the run", async () => {
    const { traceStore, store } = await makeStores();
    const denied = {
      layer: "policy" as const,
      kind: "sandbox-denied",
      retryability: "user-action" as const,
      title: "The Runtime sandbox denied this operation",
      detail: "listen EPERM",
      remedy: "Keep the work inside /workspace.",
      exitCode: 1,
    };

    complete(traceStore, "stopped", { status: "failed", failure: denied });
    complete(traceStore, "recovered", {
      status: "completed",
      failure: denied,
      startedAt: "2026-08-26T12:01:00.000Z",
      endedAt: "2026-08-26T12:01:30.000Z",
    });

    expect(store.get("stopped")?.summary).toContain(
      "Outcome: failed, policy · sandbox-denied",
    );
    expect(store.get("recovered")?.summary).toContain(
      "Outcome: completed, recovered from policy · sandbox-denied",
    );
  });

  // The old lookup keyed on agentId, so resetting an agent's Codex session
  // carried context across a boundary the agent itself does not share.
  it("keys the chain on the Codex thread, not the agent", async () => {
    const { traceStore, store } = await makeStores();

    complete(traceStore, "old-1", { conversationId: "thread-old" });
    complete(traceStore, "new-1", {
      conversationId: "thread-new",
      startedAt: "2026-08-26T12:05:00.000Z",
      endedAt: "2026-08-26T12:05:10.000Z",
    });

    expect(store.priorFor("new-1")).toBeNull();
    expect(store.chainFor("new-1")).toHaveLength(1);
  });

  // A run that fails before thread.started has no conversation id of its own.
  // Keying strictly on the thread put those runs in a chain by themselves, so
  // prior context vanished for exactly the early failures it was most wanted
  // for. A thread-less run is adopted by the session that surrounds it.
  it("adopts a run that failed before its Codex session started", async () => {
    const { traceStore, store } = await makeStores();

    complete(traceStore, "run-0", {
      conversationId: null,
      status: "failed",
      prompt: "first attempt",
    });
    complete(traceStore, "run-1", {
      startedAt: "2026-08-26T12:01:00.000Z",
      endedAt: "2026-08-26T12:01:30.000Z",
    });

    expect(store.chainFor("run-1")).toHaveLength(2);
    expect(store.priorFor("run-1")?.traceId).toBe("run-0");
    expect(store.priorFor("run-1")?.summary).toContain("first attempt");
  });

  // The property the thread keying existed to protect: a session reset is a
  // real boundary and must still not be crossed.
  it("does not adopt a thread-less run across a session reset", async () => {
    const { traceStore, store } = await makeStores();

    complete(traceStore, "old-1", { conversationId: "thread-old" });
    complete(traceStore, "orphan", {
      conversationId: null,
      status: "failed",
      startedAt: "2026-08-26T12:02:00.000Z",
      endedAt: "2026-08-26T12:02:10.000Z",
    });
    complete(traceStore, "new-1", {
      conversationId: "thread-new",
      startedAt: "2026-08-26T12:05:00.000Z",
      endedAt: "2026-08-26T12:05:10.000Z",
    });

    // The orphan sits between the two sessions and belongs to the one it was
    // an attempt at — the one that started next.
    expect(store.chainFor("old-1").map((entry) => entry.traceId)).toEqual([
      "old-1",
    ]);
    expect(store.chainFor("new-1").map((entry) => entry.traceId)).toEqual([
      "orphan",
      "new-1",
    ]);
  });

  it("reports position on the thread", async () => {
    const { traceStore, service } = await makeStores();

    complete(traceStore, "run-1");
    complete(traceStore, "run-2", {
      startedAt: "2026-08-26T12:01:00.000Z",
      endedAt: "2026-08-26T12:01:30.000Z",
    });
    complete(traceStore, "run-3", {
      startedAt: "2026-08-26T12:02:00.000Z",
      endedAt: "2026-08-26T12:02:30.000Z",
    });

    const view = service.view("run-2");
    expect(view.position).toBe(2);
    expect(view.chainLength).toBe(3);
    expect(view.previousTraceId).toBe("run-1");
    expect(view.nextTraceId).toBe("run-3");
    expect(view.carriedIn?.traceId).toBe("run-1");
  });

  it("lets a model summary replace the digest, but never erase it", async () => {
    const { traceStore, store } = await makeStores();
    complete(traceStore, "run-1");

    store.enrich("run-1", "Goal: count files. Agent listed the workspace.");
    expect(store.get("run-1")?.source).toBe("model");
    expect(store.get("run-1")?.summary).toContain("Goal: count files");

    // A failed audit hands over an empty verdict; the digest has to survive it.
    store.enrich("run-1", "");
    expect(store.get("run-1")?.summary).toContain("Goal: count files");
  });

  it("survives a restart", async () => {
    const { traceStore, store, directory } = await makeStores();
    complete(traceStore, "run-1");
    await store.flush();

    const reopened = new ContextStore(path.join(directory, "context"));
    await reopened.initialize();
    expect(reopened.get("run-1")?.summary).toContain("count files");
  });
});
