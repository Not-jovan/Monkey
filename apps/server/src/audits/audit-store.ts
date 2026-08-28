import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord } from "../traces/trace-model.js";
import {
  chatAuditSchema,
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

export class AuditStore {
  private readonly docs = new Map<string, ChatAudit>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

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
  ) {
    const doc = this.ensure(trace, intentId);
    const existing = doc.spanAudit[spanId] ?? [];
    doc.spanAudit[spanId] = existing.concat(steps);
    this.persist(trace.id);
  }

  recordRun(
    trace: TraceRecord,
    steps: AuditTraceStep[],
    contextSummary: string,
    intentId: string,
  ) {
    const doc = this.ensure(trace, intentId);
    doc.runAudit = doc.runAudit.concat(steps);
    doc.contextSummary = contextSummary;
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

  listByTrace(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    return findingsOf(doc);
  }

  isRunComplete(traceId: string) {
    return (this.docs.get(traceId)?.summary.endTime ?? 0) > 0;
  }

  intentId(traceId: string) {
    return this.docs.get(traceId)?.intentId ?? null;
  }

  countStepsForTrace(traceId: string) {
    return Object.keys(this.docs.get(traceId)?.spanAudit ?? {}).length;
  }

  warningCountByTrace() {
    const counts = new Map<string, number>();
    for (const [chatId, doc] of this.docs) {
      counts.set(chatId, findingsOf(doc).length);
    }
    return counts;
  }

  priorRollout(agentId: string) {
    let best: ChatAudit | null = null;
    for (const doc of this.docs.values()) {
      if (doc.agentId !== agentId) continue;
      if (doc.summary.endTime <= 0) continue;
      if (!best || doc.summary.endTime > best.summary.endTime) best = doc;
    }
    return best?.contextSummary ?? "";
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
        contextSummary: "",
        summary: {
          priorRollout: this.priorRollout(trace.agentId),
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
      .catch(() => undefined);
  }
}
