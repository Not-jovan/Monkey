import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyUsage, type TraceRecord } from "../trace/trace-model.js";
import { AuditStore } from "./audit-store.js";
import type { AuditTraceStep } from "./audit-model.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "audit-store-"));
  directories.push(root);
  const directory = path.join(root, "audits");
  const store = new AuditStore(directory);
  await store.initialize();
  return { store, directory };
}

const TRACE_ID = "trace-1";

function trace(): TraceRecord {
  return {
    version: 1,
    id: TRACE_ID,
    agentId: "agent-1",
    conversationId: null,
    status: "completed",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:10.000Z",
    prompt: "count files",
    model: null,
    usage: emptyUsage(),
    failingSpanId: null,
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    auditOf: "other-trace",
    auditDepth: 1,
    spans: [],
  };
}

function finding(id: string): AuditTraceStep {
  return {
    id,
    traceId: TRACE_ID,
    agentId: "agent-1",
    spanId: null,
    intentId: "",
    type: "warning",
    // Deliberately not audit-health: mergeSteps collapses those across the
    // whole document, which would confuse a test about one span's entry.
    category: "security",
    finding: id,
  };
}

describe("AuditStore re-audit", () => {
  // Asking an auditor the same question again produces the same shape of
  // answer, so the span's entry is replaced rather than added to.
  it("replaces a span's answer instead of doubling it", async () => {
    const { store } = await makeStore();
    store.replaceSpan(trace(), "span-1", [finding("first")], "");

    store.replaceSpan(trace(), "span-1", [finding("second")], "");

    const findings = store.listByTrace(TRACE_ID).map((entry) => entry.id);
    expect(findings).toEqual(["second"]);
  });

  // The heart of it. A re-audit interrupted partway used to leave the trace
  // with nothing at all, and nothing resumes a requested audit — so the pass
  // it was replacing has to still be readable afterwards.
  it("keeps the previous pass when a re-audit is interrupted partway", async () => {
    const { store } = await makeStore();
    store.replaceSpan(trace(), "span-1", [finding("old-one")], "");
    store.replaceSpan(trace(), "span-2", [finding("old-two")], "");

    // A re-audit starts...
    store.beginPass(trace());
    // ...gets through the first span, and the process dies.
    store.replaceSpan(trace(), "span-1", [finding("new-one")], "");

    // The interrupted pass holds only what it got to.
    expect(store.listByTrace(TRACE_ID).map((entry) => entry.id)).toEqual([
      "new-one",
    ]);

    // But the pass it replaced is intact, both spans of it, so the work is
    // superseded rather than lost.
    const [previous] = store.passesFor(TRACE_ID);
    expect(previous).toBeDefined();
    const superseded = Object.values(previous!.spanAudit)
      .flat()
      .map((entry) => entry.id)
      .sort();
    expect(superseded).toEqual(["old-one", "old-two"]);
  });

  it("files nothing when there is no previous answer to supersede", async () => {
    const { store } = await makeStore();

    store.beginPass(trace());

    expect(store.passesFor(TRACE_ID)).toEqual([]);
  });

  it("keeps only the most recent passes", async () => {
    const { store } = await makeStore();
    for (let round = 0; round < 8; round += 1) {
      store.replaceSpan(trace(), "span-1", [finding("round-" + round)], "");
      store.beginPass(trace());
    }

    expect(store.passesFor(TRACE_ID)).toHaveLength(5);
    // The oldest are the ones dropped.
    const first = store.passesFor(TRACE_ID)[0];
    expect(
      Object.values(first!.spanAudit).flat()[0]?.id,
    ).toBe("round-3");
  });

  // AuditStore discards a document it cannot parse and says nothing about it,
  // so a field added without a default would delete every audit ever written.
  it("still reads a document saved before history existed", async () => {
    const { store, directory } = await makeStore();
    store.replaceSpan(trace(), "span-1", [finding("kept")], "");
    await store.flush();

    const file = path.join(directory, TRACE_ID + ".json");
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    delete saved.history;
    await writeFile(file, JSON.stringify(saved, null, 2) + "\n", "utf8");

    const reopened = new AuditStore(directory);
    await reopened.initialize();

    expect(await readdir(directory)).toContain(TRACE_ID + ".json");
    expect(reopened.listByTrace(TRACE_ID).map((entry) => entry.id)).toEqual([
      "kept",
    ]);
    expect(reopened.passesFor(TRACE_ID)).toEqual([]);
  });
});
