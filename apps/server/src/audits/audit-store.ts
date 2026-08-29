import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord } from "../traces/trace-model.js";
import {
  chatAuditSchema,
  worstHealth,
  type AuditHealth,
  type AuditTraceStep,
  type ChatAudit,
} from "./audit-model.js";

function tokensFrom(trace: TraceRecord) {
  return {
    input: trace.usage.inputTokens,
    output: trace.usage.outputTokens,
    cached: trace.usage.cachedTokens,
    reasoning: trace.usage.reasoningTokens,
  };
}

function findingsOf(doc: ChatAudit) {
  return [...Object.values(doc.spanAudit).flat(), ...doc.runAudit].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

// What the agent did, as opposed to what the auditor managed to do about it.
// Only these belong in a warning count.
function agentFindingsOf(doc: ChatAudit) {
  return findingsOf(doc).filter(
    (finding) => finding.category !== "audit-health",
  );
}

export class AuditStore {
  private readonly docs = new Map<string, ChatAudit>();
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
        const doc = chatAuditSchema.parse(
          JSON.parse(await readFile(path.join(this.directory, entry), "utf8")),
        );
        this.docs.set(entry.slice(0, -".json".length), doc);
      } catch {
        // Ignore unreadable audit files.
      }
    }
  }

  recordSpan(
    trace: TraceRecord,
    spanId: string,
    steps: AuditTraceStep[],
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    const existing = doc.spanAudit[spanId] ?? [];
    doc.spanAudit[spanId] = existing.concat(steps);
    doc.health = worstHealth(doc.health, health);
    this.persist(trace.id);
  }

  recordRun(
    trace: TraceRecord,
    steps: AuditTraceStep[],
    contextSummary: string,
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    doc.runAudit = doc.runAudit.concat(steps);
    doc.contextSummary = contextSummary;
    doc.health = worstHealth(doc.health, health);
    this.syncFromTrace(doc, trace);
    if (trace.status !== "running") {
      if (trace.endedAt) {
        doc.summary.endTime = Date.parse(trace.endedAt);
      } else {
        doc.summary.endTime = Date.parse(trace.startedAt);
      }
    }
    this.persist(trace.id);
  }

  // A run-level finding that must not close the run audit out. Intent
  // classification fails while the run is still in flight, and borrowing
  // recordRun here would stamp an endTime and make the trace look audited
  // before the real run-level audit has happened.
  recordRunFinding(
    trace: TraceRecord,
    steps: AuditTraceStep[],
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    doc.runAudit = doc.runAudit.concat(steps);
    doc.health = worstHealth(doc.health, health);
    this.persist(trace.id);
  }

  listByTrace(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    return findingsOf(doc);
  }

  isRunComplete(traceId: string) {
    return (this.docs.get(traceId)?.summary.endTime ?? 0) > 0;
  }

  // Every spec version this trace's findings were judged against, in the order
  // they were first used. Derived from the findings rather than read off the
  // document, whose own field is last-writer-wins and so reports the version
  // that happened to be current when the final finding landed — wrong for
  // exactly the runs that matter, the ones that span a spec change.
  intentIds(traceId: string): string[] {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    const seen = findingsOf(doc)
      .map((finding) => finding.intentId)
      .filter((id) => id.length > 0);
    const ordered = [...new Set(seen)];
    // Audits written before findings carried a version still have the document
    // field, and it is the only answer available for them.
    if (ordered.length === 0 && doc.intentId.length > 0) return [doc.intentId];
    return ordered;
  }

  // The version the run began under: the one a reader means by "the spec this
  // trace was judged against" when there is only room to name one.
  intentId(traceId: string) {
    return this.intentIds(traceId)[0] ?? null;
  }

  countStepsForTrace(traceId: string) {
    return Object.keys(this.docs.get(traceId)?.spanAudit ?? {}).length;
  }

  // Findings about the agent only. An auditor outage no longer inflates this.
  warningCountByTrace() {
    const counts = new Map<string, number>();
    for (const [chatId, doc] of this.docs) {
      counts.set(chatId, agentFindingsOf(doc).length);
    }
    return counts;
  }

  health(traceId: string): AuditHealth {
    return this.docs.get(traceId)?.health ?? "ok";
  }

  healthByTrace() {
    const health = new Map<string, AuditHealth>();
    for (const [chatId, doc] of this.docs) health.set(chatId, doc.health);
    return health;
  }

  async flush() {
    await this.queue;
  }

  private ensure(trace: TraceRecord, intentId: string) {
    let doc = this.docs.get(trace.id);
    if (!doc) {
      doc = {
        agentId: trace.agentId,
        intentId,
        health: "ok",
        contextSummary: "",
        summary: {
          tokenSummary: tokensFrom(trace),
          startTime: Date.parse(trace.startedAt),
          endTime: 0,
          model: trace.model ?? "",
        },
        spanAudit: {},
        runAudit: [],
      };
      this.docs.set(trace.id, doc);
      return doc;
    }
    if (intentId.length > 0) doc.intentId = intentId;
    this.syncFromTrace(doc, trace);
    return doc;
  }

  private syncFromTrace(doc: ChatAudit, trace: TraceRecord) {
    doc.summary.tokenSummary = tokensFrom(trace);
    doc.summary.model = trace.model ?? "";
    doc.summary.startTime = Date.parse(trace.startedAt);
  }

  private persist(chatId: string) {
    const doc = this.docs.get(chatId);
    if (!doc) return;
    const filePath = path.join(this.directory, chatId + ".json");
    const snapshot = JSON.stringify(doc, null, 1);
    this.queue = this.queue
      .then(async () => {
        await writeFile(filePath + ".tmp", snapshot + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(filePath + ".tmp", filePath);
      })
      .catch((error) =>
        this.log?.("failed to persist audit for trace " + chatId, error),
      );
  }
}
