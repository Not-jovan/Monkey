import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  traceRecordSchema,
  type TraceRecord,
  type TraceSpan,
} from "./trace-model.js";

interface TraceStoreEvents {
  span: [{ trace: TraceRecord; span: TraceSpan }];
  "trace-completed": [{ trace: TraceRecord }];
}

export class TraceStore extends EventEmitter<TraceStoreEvents> {
  private readonly traces = new Map<string, TraceRecord>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  // audited trace id -> the auditor traces that judged it, in insertion order.
  // Re-auditing used to keep only the newest id, so a pass that failed partway
  // hid every earlier one. Newest-first is decided at read time from startedAt,
  // because boot reads files in directory order, not chronological order.
  private readonly auditorOf = new Map<string, string[]>();

  constructor(
    private readonly directory: string,
    // Reports a write that did not land. Persistence is deliberately
    // fire-and-forget so a slow disk cannot stall a run, but swallowing the
    // error let the in-memory state and the file diverge in silence: after a
    // restart the data is simply gone, with nothing anywhere having said so.
    private readonly log?: (message: string, error?: unknown) => void,
  ) {
    super();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory);
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      const filePath = path.join(this.directory, entry);
      try {
        const trace = traceRecordSchema.parse(
          JSON.parse(await readFile(filePath, "utf8")),
        );
        if (trace.status === "running") {
          trace.status = "failed";
          trace.endedAt = trace.endedAt ?? new Date().toISOString();
          for (const span of trace.spans) {
            if (span.status === "running") {
              span.status = "error";
              span.error = span.error ?? "Server restarted during this run";
              span.endedAt = span.endedAt ?? trace.endedAt;
            }
          }
        }
        this.traces.set(trace.id, trace);
        this.indexAudit(trace);
      } catch {
        // Skip unreadable files rather than refusing to boot.
      }
    }
  }

  create(trace: TraceRecord) {
    this.traces.set(trace.id, trace);
    this.indexAudit(trace);
    this.persistTrace(trace.id);
    return trace;
  }

  // The newest auditor trace that judged this one, if any.
  auditorTraceFor(traceId: string) {
    return this.auditorAttemptsFor(traceId)[0]?.id ?? null;
  }

  // Every auditor pass over this trace, newest first. A retry after a mid-run
  // failure is a second pass, not a replacement — both have to stay readable.
  auditorAttemptsFor(traceId: string) {
    const ids = this.auditorOf.get(traceId) ?? [];
    const attempts: {
      id: string;
      status: TraceRecord["status"];
      startedAt: string;
      endedAt: string | null;
    }[] = [];
    for (const id of ids) {
      const trace = this.traces.get(id);
      if (!trace) continue;
      attempts.push({
        id: trace.id,
        status: trace.status,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
      });
    }
    attempts.sort((left, right) => {
      const byStart = right.startedAt.localeCompare(left.startedAt);
      return byStart !== 0 ? byStart : right.id.localeCompare(left.id);
    });
    return attempts;
  }

  // The chain from this trace up to the agent run at the root of it, oldest
  // first. Walks auditOf with a seen-set: a corrupted file that pointed a
  // trace at itself would otherwise hang the request that read it.
  auditChain(traceId: string): TraceRecord[] {
    const chain: TraceRecord[] = [];
    const seen = new Set<string>();
    let current = this.traces.get(traceId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(structuredClone(current));
      current = current.auditOf ? this.traces.get(current.auditOf) : undefined;
    }
    return chain;
  }

  private indexAudit(trace: TraceRecord) {
    if (trace.auditOf === null) return;
    const existing = this.auditorOf.get(trace.auditOf) ?? [];
    if (existing.includes(trace.id)) return;
    existing.push(trace.id);
    this.auditorOf.set(trace.auditOf, existing);
  }

  get(traceId: string) {
    const trace = this.traces.get(traceId);
    return trace ? structuredClone(trace) : null;
  }

  // Newest first, across every agent. The auditor uses this at boot to find
  // runs that ended without ever being judged.
  list() {
    return [...this.traces.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((trace) => structuredClone(trace));
  }

  listByAgent(agentId: string) {
    return [...this.traces.values()]
      .filter((trace) => trace.agentId === agentId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((trace) => structuredClone(trace));
  }

  appendSpan(traceId: string, span: TraceSpan) {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    trace.spans.push(span);
    this.persistTrace(traceId);
    this.emit("span", { trace: structuredClone(trace), span: structuredClone(span) });
    return span;
  }

  updateSpan(
    traceId: string,
    spanId: string,
    mutate: (span: TraceSpan) => void,
    options: { emit?: boolean } = {},
  ) {
    const trace = this.traces.get(traceId);
    const span = trace?.spans.find((item) => item.id === spanId);
    if (!trace || !span) return null;
    mutate(span);
    this.persistTrace(traceId);
    if (options.emit) {
      this.emit("span", {
        trace: structuredClone(trace),
        span: structuredClone(span),
      });
    }
    return span;
  }

  // Re-announces a span that is already stored. Used when a span becomes
  // judgeable later than it became final — a tool denied at decision time only
  // has a name until its result arrives, and a run that ends without one has to
  // hand the auditor its last look explicitly.
  emitSpan(traceId: string, spanId: string) {
    const trace = this.traces.get(traceId);
    const span = trace?.spans.find((item) => item.id === spanId);
    if (!trace || !span) return null;
    this.emit("span", {
      trace: structuredClone(trace),
      span: structuredClone(span),
    });
    return span;
  }

  updateTrace(traceId: string, mutate: (trace: TraceRecord) => void) {
    const trace = this.traces.get(traceId);
    if (!trace) return null;
    const wasCompleted = trace.status !== "running";
    mutate(trace);
    this.persistTrace(traceId);
    if (!wasCompleted && trace.status !== "running") {
      this.emit("trace-completed", { trace: structuredClone(trace) });
    }
    return structuredClone(trace);
  }

  async flush() {
    await Promise.all([...this.writeQueues.values()]);
  }

  private persistTrace(traceId: string) {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    const filePath = path.join(this.directory, traceId + ".json");
    const snapshot = JSON.stringify(trace, null, 1);
    const queue = (this.writeQueues.get(traceId) ?? Promise.resolve()).then(
      async () => {
        const temporary = filePath + ".tmp";
        await writeFile(temporary, snapshot + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, filePath);
      },
    );
    this.writeQueues.set(
      traceId,
      queue.catch((error) =>
        this.log?.("failed to persist trace " + traceId, error),
      ),
    );
  }
}
