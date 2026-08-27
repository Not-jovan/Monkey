import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditSteps,
  emitPolicyFindings,
  type AuditTraceStep,
  type NewObjectiveFinding,
  type SecretExposureFinding,
} from "./audit-model.js";

type AuditMeta = {
  auditedSpans: Record<string, string[]>;
  completedRuns: string[];
  intentContext: Record<string, string>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAuditTraceStep(value: unknown): value is AuditTraceStep {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.traceId === "string" &&
    typeof value.agentId === "string" &&
    (typeof value.spanId === "string" || value.spanId === null) &&
    (value.type === "warning" || value.type === "error") &&
    (value.category === "intent-check" || value.category === "security") &&
    typeof value.finding === "string"
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function legacySteps(raw: Record<string, unknown>): AuditTraceStep[] | null {
  if (raw.version !== 1 || typeof raw.id !== "string") return null;
  if (typeof raw.traceId !== "string" || typeof raw.agentId !== "string") {
    return null;
  }
  const newObjectives: NewObjectiveFinding[] = Array.isArray(raw.newObjectives)
    ? raw.newObjectives.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.objective !== "string") return [];
        return [
          {
            objective: entry.objective,
            requestedByUser: asBoolean(entry.requestedByUser, false),
            actedUpon: asBoolean(entry.actedUpon, false),
          },
        ];
      })
    : [];
  const secretExposures: SecretExposureFinding[] = Array.isArray(
    raw.secretExposures,
  )
    ? raw.secretExposures.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.secretType !== "string") return [];
        if (entry.location !== "request" && entry.location !== "response") {
          return [];
        }
        return [
          {
            location: entry.location,
            secretType: entry.secretType,
            relevant:
              entry.relevant === true || entry.relevant === false
                ? entry.relevant
                : null,
            reason: typeof entry.reason === "string" ? entry.reason : "",
          },
        ];
      })
    : [];
  const reason = typeof raw.reason === "string" ? raw.reason : "";
  const kind = raw.phase === "run" || raw.type === "intent" ? "run" : "step";
  return auditSteps(
    {
      id: raw.id,
      traceId: raw.traceId,
      agentId: raw.agentId,
      spanId: typeof raw.spanId === "string" ? raw.spanId : null,
    },
    (push) => {
      emitPolicyFindings(push, {
        notInAlignment: stringArray(raw.notInAlignment),
        newObjectives,
        networkViolations: stringArray(raw.networkViolations),
        secretExposures,
      });
      for (const tag of stringArray(raw.findings)) {
        if (
          tag === "network-whitelist-violation" ||
          tag === "secret-egress" ||
          tag === "intent-deviation" ||
          tag === "intent-misalignment" ||
          tag === "injected-objective"
        ) {
          continue;
        }
        push("warning", "security", tag + (reason ? ": " + reason : ""));
      }
      if (raw.status === "failed") {
        push(
          "error",
          kind === "run" ? "intent-check" : "security",
          "The audit could not be completed" + (reason ? ": " + reason : "."),
        );
      }
    },
  );
}

function parseMeta(value: unknown): AuditMeta {
  if (!isObject(value)) {
    return { auditedSpans: {}, completedRuns: [], intentContext: {} };
  }
  const auditedSpans: Record<string, string[]> = {};
  if (isObject(value.auditedSpans)) {
    for (const [traceId, spanIds] of Object.entries(value.auditedSpans)) {
      auditedSpans[traceId] = stringArray(spanIds);
    }
  }
  const intentContext: Record<string, string> = {};
  if (isObject(value.intentContext)) {
    for (const [agentId, summary] of Object.entries(value.intentContext)) {
      if (typeof summary === "string" && summary.length > 0) {
        intentContext[agentId] = summary;
      }
    }
  }
  return {
    auditedSpans,
    completedRuns: stringArray(value.completedRuns),
    intentContext,
  };
}

// Findings persist apart from traces (audits/<id>.json) and reference them
// only through traceId/spanId, keeping the auditor a pure reader of trace data.
export class AuditStore {
  private readonly steps = new Map<string, AuditTraceStep>();
  private readonly auditedSpans = new Map<string, Set<string>>();
  private readonly completedRuns = new Set<string>();
  private readonly intentContext = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    try {
      const metaRaw = JSON.parse(
        await readFile(path.join(this.directory, "_meta.json"), "utf8"),
      ) as unknown;
      const meta = parseMeta(metaRaw);
      for (const [traceId, spanIds] of Object.entries(meta.auditedSpans)) {
        this.auditedSpans.set(traceId, new Set(spanIds));
      }
      for (const traceId of meta.completedRuns) this.completedRuns.add(traceId);
      for (const [agentId, summary] of Object.entries(meta.intentContext)) {
        this.intentContext.set(agentId, summary);
      }
    } catch {
      // First boot, or a missing/unreadable sidecar. Findings files still load.
    }

    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json") || entry === "_meta.json") continue;
      try {
        const raw: unknown = JSON.parse(
          await readFile(path.join(this.directory, entry), "utf8"),
        );
        if (isAuditTraceStep(raw)) {
          this.steps.set(raw.id, raw);
          continue;
        }
        if (!isObject(raw)) continue;
        const steps = legacySteps(raw);
        if (!steps) continue;
        for (const step of steps) this.steps.set(step.id, step);
        const spanId = typeof raw.spanId === "string" ? raw.spanId : null;
        const kind = raw.phase === "run" || raw.type === "intent" ? "run" : "step";
        if (kind === "step" && spanId) {
          this.rememberSpan(String(raw.traceId), spanId);
        }
        if (kind === "run" && typeof raw.traceId === "string") {
          this.completedRuns.add(raw.traceId);
          if (
            typeof raw.contextSummary === "string" &&
            raw.contextSummary.length > 0 &&
            raw.status !== "failed" &&
            typeof raw.agentId === "string"
          ) {
            this.intentContext.set(raw.agentId, raw.contextSummary);
          }
        }
      } catch {
        // Ignore unreadable audit files.
      }
    }
  }

  add(steps: AuditTraceStep[]) {
    for (const step of steps) {
      this.steps.set(step.id, step);
      const filePath = path.join(this.directory, encodeURIComponent(step.id) + ".json");
      const snapshot = JSON.stringify(step, null, 1);
      this.enqueueWrite(filePath, snapshot);
    }
  }

  noteStep(traceId: string, spanId: string) {
    this.rememberSpan(traceId, spanId);
    this.persistMeta();
  }

  noteRun(traceId: string, agentId: string, contextSummary: string | null) {
    this.completedRuns.add(traceId);
    if (contextSummary && contextSummary.length > 0) {
      this.intentContext.set(agentId, contextSummary);
    }
    this.persistMeta();
  }

  listByTrace(traceId: string) {
    return [...this.steps.values()]
      .filter((step) => step.traceId === traceId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  isRunComplete(traceId: string) {
    return this.completedRuns.has(traceId);
  }

  // Only step audits count against the per-trace budget; the single run-level
  // intent audit must never be crowded out by a long run.
  countStepsForTrace(traceId: string) {
    return this.auditedSpans.get(traceId)?.size ?? 0;
  }

  warningCountByTrace() {
    const counts = new Map<string, number>();
    for (const step of this.steps.values()) {
      counts.set(step.traceId, (counts.get(step.traceId) ?? 0) + 1);
    }
    return counts;
  }

  latestIntentContext(agentId: string) {
    return this.intentContext.get(agentId) ?? null;
  }

  async flush() {
    await this.queue;
  }

  private rememberSpan(traceId: string, spanId: string) {
    let spans = this.auditedSpans.get(traceId);
    if (!spans) {
      spans = new Set();
      this.auditedSpans.set(traceId, spans);
    }
    spans.add(spanId);
  }

  private persistMeta() {
    const snapshot: AuditMeta = {
      auditedSpans: Object.fromEntries(
        [...this.auditedSpans.entries()].map(([traceId, spans]) => [
          traceId,
          [...spans],
        ]),
      ),
      completedRuns: [...this.completedRuns],
      intentContext: Object.fromEntries(this.intentContext),
    };
    this.enqueueWrite(
      path.join(this.directory, "_meta.json"),
      JSON.stringify(snapshot, null, 1),
    );
  }

  private enqueueWrite(filePath: string, snapshot: string) {
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
