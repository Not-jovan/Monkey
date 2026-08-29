import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceRecord, TraceSpan } from "../traces/trace-model.js";
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

// One health note is enough. A 30-step run that fell back on every call
// would otherwise repeat the same "primary model is not available" line.
function mergeSteps(doc: ChatAudit, steps: AuditTraceStep[]) {
  const rest = steps.filter((step) => step.category !== "audit-health");
  const incoming = steps.filter((step) => step.category === "audit-health");
  if (incoming.length === 0) return rest;
  const have = findingsOf(doc).filter((step) => step.category === "audit-health");
  if (have.some((step) => step.type === "error")) return rest;
  if (have.length > 0) {
    return rest.concat(incoming.filter((step) => step.type === "error"));
  }
  return rest.concat(incoming);
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
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    const existing = doc.spanAudit[spanId] ?? [];
    doc.spanAudit[spanId] = existing.concat(mergeSteps(doc, steps));
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
    doc.runAudit = doc.runAudit.concat(mergeSteps(doc, steps));
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

  appendAuditorSpans(
    trace: TraceRecord,
    spans: TraceSpan[],
    intentId: string,
  ) {
    if (spans.length === 0) return;
    const doc = this.ensure(trace, intentId);
    doc.auditorSpans = doc.auditorSpans.concat(spans);
    this.persist(trace.id);
  }

  listAuditorSpans(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    return [...doc.auditorSpans];
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
        auditorSpans: [],
      };
      this.docs.set(trace.id, doc);
      return doc;
    }
    // The first audit pins the specification for this trace. Later step
    // records may finish after the Agent's active intent changes, but they
    // must not relabel historical evidence with that newer version (including
    // replacing an intentionally empty id for a trace with no standing spec).
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
