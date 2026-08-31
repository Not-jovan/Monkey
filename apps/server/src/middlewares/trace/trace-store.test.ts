import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    auditOf: null,
    auditDepth: 0,
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

  it("indexes an auditor trace against what it audited, across a restart", async () => {
    const { store, directory } = await makeStore();
    store.create(trace("agent-run"));
    const audit = { ...trace("audit-run"), auditOf: "agent-run", auditDepth: 1 };
    store.create(audit);

    expect(store.auditorTraceFor("agent-run")).toBe("audit-run");
    expect(store.auditorTraceFor("audit-run")).toBeNull();

    await store.flush();
    const reopened = new TraceStore(directory);
    await reopened.initialize();
    expect(reopened.auditorTraceFor("agent-run")).toBe("audit-run");
  });

  // Re-auditing used to overwrite the index, so a pass that failed partway
  // hid the one it was replacing. Both have to stay, and the newest is still
  // the one auditorTraceFor names.
  it("keeps every auditor pass over a trace, not only the newest", async () => {
    const { store, directory } = await makeStore();
    store.create(trace("agent-run"));
    store.create({
      ...trace("audit-first"),
      auditOf: "agent-run",
      auditDepth: 1,
      status: "failed",
      startedAt: "2026-08-26T12:00:00.000Z",
      endedAt: "2026-08-26T12:00:30.000Z",
    });
    store.create({
      ...trace("audit-second"),
      auditOf: "agent-run",
      auditDepth: 1,
      status: "completed",
      startedAt: "2026-08-26T12:01:00.000Z",
      endedAt: "2026-08-26T12:01:20.000Z",
    });

    expect(store.auditorTraceFor("agent-run")).toBe("audit-second");
    expect(store.auditorAttemptsFor("agent-run").map((entry) => entry.id)).toEqual(
      ["audit-second", "audit-first"],
    );

    await store.flush();
    const reopened = new TraceStore(directory);
    await reopened.initialize();
    expect(reopened.auditorTraceFor("agent-run")).toBe("audit-second");
    expect(
      reopened.auditorAttemptsFor("agent-run").map((entry) => entry.id),
    ).toEqual(["audit-second", "audit-first"]);
  });

  // The stack has no ceiling, so the walk back to the Agent run must not either.
  it("walks the chain from any depth back to the agent run", async () => {
    const { store } = await makeStore();
    store.create(trace("level-0"));
    for (let depth = 1; depth <= 5; depth += 1) {
      store.create({
        ...trace("level-" + depth),
        auditOf: "level-" + (depth - 1),
        auditDepth: depth,
      });
    }

    for (let depth = 0; depth <= 5; depth += 1) {
      const chain = store.auditChain("level-" + depth);
      expect(chain).toHaveLength(depth + 1);
      expect(chain.map((entry) => entry.id)).toEqual(
        Array.from({ length: depth + 1 }, (_, index) => "level-" + index),
      );
    }
  });

  // A corrupted file pointing a trace at itself would otherwise hang the
  // request that read it.
  it("does not loop on a chain that points at itself", async () => {
    const { store } = await makeStore();
    store.create({ ...trace("loop"), auditOf: "loop", auditDepth: 1 });
    expect(store.auditChain("loop").map((entry) => entry.id)).toEqual(["loop"]);
  });

  // Written before auditors had traces of their own. It is an agent run, and
  // must not read as an auditor's.
  it("reads a trace written before the audit fields existed as depth zero", async () => {
    const { store, directory } = await makeStore();
    const legacy = trace("legacy") as Record<string, unknown>;
    delete legacy.auditOf;
    delete legacy.auditDepth;
    await writeFile(
      path.join(directory, "legacy.json"),
      JSON.stringify(legacy) + "\n",
      "utf8",
    );

    const reopened = new TraceStore(directory);
    await reopened.initialize();
    expect(reopened.get("legacy")?.auditOf).toBeNull();
    expect(reopened.get("legacy")?.auditDepth).toBe(0);
  });
});
