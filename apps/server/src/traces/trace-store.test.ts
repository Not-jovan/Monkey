import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceRecord, TraceSpan } from "./trace-model.js";
import { emptyUsage } from "./trace-model.js";
import { TraceStore } from "./trace-store.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function makeStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "trace-store-"));
  const store = new TraceStore(directory);
  await store.initialize();
  cleanups.push(async () => {
    await store.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return { store, directory };
}

function trace(id: string): TraceRecord {
  return {
    version: 1,
    id,
    agentId: "agent-1",
    conversationId: null,
    status: "running",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: null,
    prompt: "count files",
    model: null,
    usage: emptyUsage(),
    failingSpanId: null,
    unrecognizedEvents: 0,
    spans: [],
  };
}

function span(id: string, traceId: string): TraceSpan {
  return {
    id,
    traceId,
    parentId: null,
    name: "agent.run",
    label: "Agent run",
    kind: "run",
    actor: "agent",
    status: "running",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: null,
    durationMs: null,
    attributes: {},
    error: null,
  };
}

describe("TraceStore", () => {
  it("emits span events and persists traces across restarts", async () => {
    const { store, directory } = await makeStore();
    const seen: string[] = [];
    store.on("span", ({ span: appended }) => seen.push(appended.id));

    store.create(trace("11111111-1111-4111-8111-111111111111"));
    store.appendSpan(
      "11111111-1111-4111-8111-111111111111",
      span("s1", "11111111-1111-4111-8111-111111111111"),
    );
    expect(seen).toEqual(["s1"]);
    store.updateTrace("11111111-1111-4111-8111-111111111111", (record) => {
      record.status = "completed";
      record.endedAt = "2026-08-26T12:00:05.000Z";
    });
    await store.flush();

    const reloaded = new TraceStore(directory);
    await reloaded.initialize();
    const restored = reloaded.get("11111111-1111-4111-8111-111111111111");
    expect(restored?.status).toBe("completed");
    expect(restored?.spans).toHaveLength(1);
  });

  it("fires trace-completed exactly once on the running -> done transition", async () => {
    const { store } = await makeStore();
    let fired = 0;
    store.on("trace-completed", () => {
      fired += 1;
    });
    store.create(trace("22222222-2222-4222-8222-222222222222"));
    store.updateTrace("22222222-2222-4222-8222-222222222222", (record) => {
      record.status = "failed";
    });
    store.updateTrace("22222222-2222-4222-8222-222222222222", (record) => {
      record.unrecognizedEvents += 1;
    });
    expect(fired).toBe(1);
  });

  it("closes traces left running by a crash during boot recovery", async () => {
    const { store, directory } = await makeStore();
    const open = trace("33333333-3333-4333-8333-333333333333");
    store.create(open);
    store.appendSpan(open.id, span("s1", open.id));
    await store.flush();

    const recovered = new TraceStore(directory);
    await recovered.initialize();
    const restored = recovered.get(open.id);
    expect(restored?.status).toBe("failed");
    expect(restored?.spans[0]?.status).toBe("error");
    expect(restored?.spans[0]?.error).toContain("restarted");
  });
});
