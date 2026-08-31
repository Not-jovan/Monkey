import { access, appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "./redaction.js";
import type { RuntimeTraceAdapter, TimestampedEvent } from "./runtime-events.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

const temporaryDirectories: string[] = [];
const activeStores: TraceStore[] = [];

afterEach(async () => {
  // TraceStore persists through a fire-and-forget queue; removing a
  // directory while a write is still in flight races rename() and can leave
  // rmdir seeing a non-empty directory. Flush every store this run touched
  // before cleaning up.
  await Promise.all(activeStores.splice(0).map((store) => store.flush()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

// A minimal stand-in for the real Codex/Claude Code adapters: one line of
// plain text per event, located at a predictable path instead of a glob.
// The cursor/scraping/reconciliation behavior under test doesn't depend on
// real session-log parsing fidelity — that's covered by
// codex-rollout.test.ts and claude-code-session.test.ts against real fixture
// content.
function fakeLogPath(homeDir: string, conversationId: string) {
  return path.join(homeDir, conversationId + ".jsonl");
}

const fakeAdapter: RuntimeTraceAdapter = {
  runtimeId: "codex",
  displayName: "Fake",
  async locateLog(homeDir, conversationId) {
    const filePath = fakeLogPath(homeDir, conversationId);
    try {
      await access(filePath);
      return filePath;
    } catch {
      return null;
    }
  },
  parseLog(text): TimestampedEvent[] {
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((_line, index) => ({
        event: { kind: "model_call", spanName: "test.model_call", durationMs: 10, failed: false },
        timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      }));
  },
};

async function writeFakeLogLine(homeDir: string, conversationId: string, line: string) {
  const filePath = fakeLogPath(homeDir, conversationId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, line + "\n", "utf8");
}

async function setup(secretValues: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-trace-test-"));
  temporaryDirectories.push(root);
  const homeDir = path.join(root, "runtime-home");
  const traceStore = new TraceStore(path.join(root, "traces"));
  activeStores.push(traceStore);
  await traceStore.initialize();
  const redactor = createRedactor(secretValues);
  const service = new TraceService(traceStore, redactor, fakeAdapter, homeDir);
  return { root, homeDir, traceStore, redactor, service };
}

function startRun(service: TraceService, runId: string, conversationId: string) {
  service.onRunStart(
    { id: "agent-1", name: "Agent", instructions: "do things", codexThreadId: null },
    { id: runId, prompt: "test prompt" },
  );
  service.onConversation(runId, conversationId);
}

describe("TraceService session-log scraping pipeline", () => {
  it("the cursor prevents an event from being applied twice on repeated reconciliation", async () => {
    const { homeDir, traceStore, service } = await setup();
    startRun(service, "run-1", "conv-1");
    await writeFakeLogLine(homeDir, "conv-1", "event-1");

    await service.reconcileFromDisk();
    const afterFirst = traceStore.get("run-1")!;
    expect(afterFirst.spans.filter((s) => s.kind === "model_call")).toHaveLength(1);
    expect(afterFirst.scrapeCursor).toBe(1);

    // Nothing new was written; reconciling again must not re-apply event 0.
    await service.reconcileFromDisk();
    const afterSecond = traceStore.get("run-1")!;
    expect(afterSecond.spans.filter((s) => s.kind === "model_call")).toHaveLength(1);
    expect(afterSecond.scrapeCursor).toBe(1);
  });

  it("a crash before a batch was ever scraped is fully recovered by a fresh TraceService reconciling from disk", async () => {
    const { homeDir, root, traceStore } = await setup();
    // Simulate the process that started the run and saw its session log grow:
    // the file has two lines on disk, but the process died before its own
    // poller ever scraped them — nothing in `this.runs` from that lifetime
    // survives.
    const writer = new TraceService(traceStore, createRedactor([]), fakeAdapter, homeDir);
    startRun(writer, "run-1", "conv-1");
    await writeFakeLogLine(homeDir, "conv-1", "event-1");
    await writeFakeLogLine(homeDir, "conv-1", "event-2");
    // The trace record (status "running", no spans applied for these two
    // events yet) must actually be on disk before "the process dies" —
    // otherwise this test would race persistTrace's fire-and-forget queue
    // rather than exercise the crash-recovery path it's meant to.
    await traceStore.flush();

    // A brand new TraceStore + TraceService, backed by the same directories,
    // with no in-memory RunState at all — this is what boot after a restart
    // looks like.
    const revivedStore = new TraceStore(path.join(root, "traces"));
    activeStores.push(revivedStore);
    await revivedStore.initialize();
    const revived = new TraceService(revivedStore, createRedactor([]), fakeAdapter, homeDir);
    await revived.reconcileFromDisk();

    const recovered = revivedStore.get("run-1")!;
    expect(recovered.spans.filter((s) => s.kind === "model_call")).toHaveLength(2);
    expect(recovered.scrapeCursor).toBe(2);
    // Rehydrated RunState: root/prompt spans reused from what was already
    // persisted, not recreated.
    expect(recovered.spans.filter((s) => s.kind === "run")).toHaveLength(1);
  });

  it("a conversation with no session log yet is skipped without error", async () => {
    const { service, traceStore } = await setup();
    startRun(service, "run-1", "conv-1");
    await expect(service.reconcileFromDisk()).resolves.toBeUndefined();
    expect(traceStore.get("run-1")!.spans.filter((s) => s.kind === "model_call")).toHaveLength(0);
  });
});
