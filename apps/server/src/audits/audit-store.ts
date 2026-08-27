import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditRecord } from "./audit-model.js";

// Audits persist apart from traces (audits/<audit-id>.json) and reference them
// only through traceId/spanId, keeping the auditor a pure reader of trace data.
export class AuditStore {
  private readonly audits = new Map<string, AuditRecord>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(
          await readFile(path.join(this.directory, entry), "utf8"),
        ) as AuditRecord;
        if (raw.version === 1) {
          // Records written before the deterministic checks existed have no
          // arrays; normalise so every consumer can read them the same way.
          raw.networkViolations = raw.networkViolations ?? [];
          raw.secretExposures = raw.secretExposures ?? [];
          raw.notInAlignment = raw.notInAlignment ?? [];
          raw.newObjectives = raw.newObjectives ?? [];
          this.audits.set(raw.id, raw);
        }
      } catch {
        // Ignore unreadable audit files.
      }
    }
  }

  add(record: AuditRecord) {
    this.audits.set(record.id, record);
    const filePath = path.join(this.directory, record.id + ".json");
    const snapshot = JSON.stringify(record, null, 1);
    this.queue = this.queue
      .then(async () => {
        await writeFile(filePath + ".tmp", snapshot + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(filePath + ".tmp", filePath);
      })
      .catch(() => undefined);
    return record;
  }

  listByTrace(traceId: string) {
    return [...this.audits.values()]
      .filter((audit) => audit.traceId === traceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  // Only step audits count against the per-trace budget; the single run-level
  // intent audit must never be crowded out by a long run.
  countStepsForTrace(traceId: string) {
    let count = 0;
    for (const audit of this.audits.values()) {
      if (audit.traceId === traceId && audit.phase === "step") count += 1;
    }
    return count;
  }

  warningCountByTrace() {
    const counts = new Map<string, number>();
    for (const audit of this.audits.values()) {
      if (!audit.warning) continue;
      counts.set(audit.traceId, (counts.get(audit.traceId) ?? 0) + 1);
    }
    return counts;
  }

  latestIntentContext(agentId: string) {
    let latest: AuditRecord | null = null;
    for (const audit of this.audits.values()) {
      if (audit.agentId !== agentId || audit.type !== "intent") continue;
      if (audit.status === "failed" || !audit.contextSummary) continue;
      if (!latest || audit.createdAt > latest.createdAt) latest = audit;
    }
    return latest?.contextSummary ?? null;
  }

  async flush() {
    await this.queue;
  }
}
