import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord } from "../trace/trace-model.js";
import {
  buildRunDigest,
  describeDigest,
  runContextSchema,
  type RunContext,
} from "./context-model.js";

// Deliberately its own store rather than a field on the audit document.
//
// The audit store only exists when auditing is switched on and a model answered,
// which is precisely why prior context could not previously be established: turn
// the auditor off and the chain vanished. This store is written from the
// `trace-completed` event, so a run always leaves a record behind. The auditor
// enriches that record; it does not own it.
export class ContextStore {
  private readonly records = new Map<string, RunContext>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    // Reports a write that did not land. Persistence is deliberately
    // fire-and-forget so a slow disk cannot stall a run, but swallowing the
    // error let the in-memory state and the file diverge in silence: after a
    // restart the data is simply gone, with nothing anywhere having said so.
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const parsed = runContextSchema.parse(
          JSON.parse(await readFile(path.join(this.directory, entry), "utf8")),
        );
        this.records.set(parsed.traceId, parsed);
      } catch {
        // Skip unreadable context files rather than refusing to boot.
      }
    }
  }

  // Called when a run ends, before any model has been consulted.
  record(trace: TraceRecord) {
    const digest = buildRunDigest(trace);
    const existing = this.records.get(trace.id);
    const context: RunContext = {
      version: 1,
      traceId: trace.id,
      agentId: trace.agentId,
      conversationId: trace.conversationId,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt ?? trace.startedAt,
      // A model summary already written for this run is not thrown away by a
      // later re-record.
      summary:
        existing?.source === "model" ? existing.summary : describeDigest(digest),
      source: existing?.source === "model" ? "model" : "derived",
      digest,
    };
    this.records.set(trace.id, context);
    this.persist(trace.id);
    return context;
  }

  // The auditor upgrading a derived summary once its model has answered. A
  // blank summary is ignored, so a failed audit never erases the digest.
  enrich(traceId: string, summary: string) {
    const existing = this.records.get(traceId);
    if (!existing || summary.trim().length === 0) return;
    existing.summary = summary.trim();
    existing.source = "model";
    this.persist(traceId);
  }

  get(traceId: string) {
    const found = this.records.get(traceId);
    return found ? structuredClone(found) : null;
  }

  // Every run in the same Codex session, oldest first.
  //
  // The thread is the agent's real continuity — `buildCodexArgs` issues
  // `resume <threadId>` — so a session reset is a genuine boundary and must not
  // be crossed. But a run that failed before `thread.started` arrived has no
  // thread of its own, and keying strictly on the thread id put those runs in a
  // chain by themselves: prior context vanished for exactly the early failures
  // it was most wanted for. A thread-less run is therefore adopted by the
  // session that surrounds it rather than forming an island.
  private sessionOf(entries: RunContext[]): (string | null)[] {
    const threads = entries.map((entry) => entry.conversationId);
    // A run with no thread belongs to the session that started next; it was an
    // attempt at that session. Falling back to the preceding one covers a
    // trailing failure with nothing after it.
    return threads.map((thread, index) => {
      if (thread !== null) return thread;
      for (let ahead = index + 1; ahead < threads.length; ahead += 1) {
        const found = threads[ahead];
        if (found != null) return found;
      }
      for (let behind = index - 1; behind >= 0; behind -= 1) {
        const found = threads[behind];
        if (found != null) return found;
      }
      return null;
    });
  }

  chainFor(traceId: string): RunContext[] {
    const anchor = this.records.get(traceId);
    if (!anchor) return [];
    const byAgent = [...this.records.values()]
      .filter((entry) => entry.agentId === anchor.agentId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const sessions = this.sessionOf(byAgent);
    const index = byAgent.findIndex((entry) => entry.traceId === traceId);
    if (index === -1) return [];
    const session = sessions[index] ?? null;
    return byAgent
      .filter((_, position) => sessions[position] === session)
      .map((entry) => structuredClone(entry));
  }

  // What the run at `traceId` inherited: the nearest earlier run on its thread.
  priorFor(traceId: string): RunContext | null {
    const chain = this.chainFor(traceId);
    const index = chain.findIndex((entry) => entry.traceId === traceId);
    if (index <= 0) return null;
    return chain[index - 1] ?? null;
  }

  forgetAgent(agentId: string) {
    for (const [traceId, entry] of this.records) {
      if (entry.agentId === agentId) this.records.delete(traceId);
    }
  }

  async flush() {
    await this.queue;
  }

  private persist(traceId: string) {
    const context = this.records.get(traceId);
    if (!context) return;
    const filePath = path.join(this.directory, traceId + ".json");
    const snapshot = JSON.stringify(context, null, 1);
    this.queue = this.queue
      .then(async () => {
        await writeFile(filePath + ".tmp", snapshot + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(filePath + ".tmp", filePath);
      })
      .catch((error) =>
        this.log?.("failed to persist context for trace " + traceId, error),
      );
  }
}
