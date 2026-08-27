import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntentRecord, IntentUpdate } from "./intent-model.js";

const MAX_HISTORY = 200;

// One document per agent under <dataDir>/intent, written atomically like the
// trace and audit stores.
export class IntentStore {
  private readonly records = new Map<string, IntentRecord>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const raw = JSON.parse(
          await readFile(path.join(this.directory, entry), "utf8"),
        ) as IntentRecord;
        if (raw.version === 1) {
          raw.extended = raw.extended ?? [];
          raw.history = raw.history ?? [];
          this.records.set(raw.agentId, raw);
        }
      } catch {
        // Skip unreadable intent files rather than refusing to boot.
      }
    }
  }

  get(agentId: string): IntentRecord | null {
    const record = this.records.get(agentId);
    return record ? structuredClone(record) : null;
  }

  // Seeds the objective the first time an agent is used, then leaves it alone
  // so a later run cannot silently rewrite the original goal.
  ensure(agentId: string, objective: string): IntentRecord {
    const existing = this.records.get(agentId);
    if (existing) {
      if (existing.objective.length === 0 && objective.length > 0) {
        existing.objective = objective;
        this.persist(agentId);
      }
      return structuredClone(existing);
    }
    const record: IntentRecord = {
      version: 1,
      agentId,
      objective,
      extended: [],
      updatedAt: new Date().toISOString(),
      history: [],
    };
    this.records.set(agentId, record);
    this.persist(agentId);
    return structuredClone(record);
  }

  apply(agentId: string, update: IntentUpdate): IntentRecord {
    const record = this.records.get(agentId) ?? this.ensure(agentId, "");
    const stored = this.records.get(agentId) ?? record;
    if (update.status === "applied") {
      for (const entry of update.added) {
        if (!stored.extended.includes(entry)) stored.extended.push(entry);
      }
      if (update.objectiveAfter) stored.objective = update.objectiveAfter;
    }
    stored.history.push(update);
    if (stored.history.length > MAX_HISTORY) {
      stored.history.splice(0, stored.history.length - MAX_HISTORY);
    }
    stored.updatedAt = update.at;
    this.records.set(agentId, stored);
    this.persist(agentId);
    return structuredClone(stored);
  }

  // Applies or discards an update that was held for the user to confirm. The
  // history entry stays either way, so an operator can see what was proposed
  // and what became of it.
  resolve(
    agentId: string,
    updateId: string,
    decision: "confirm" | "reject",
  ): IntentRecord | null {
    const record = this.records.get(agentId);
    const update = record?.history.find((entry) => entry.id === updateId);
    if (!record || !update || update.status !== "pending") return null;
    if (decision === "confirm") {
      for (const entry of update.added) {
        if (!record.extended.includes(entry)) record.extended.push(entry);
      }
      if (update.objectiveAfter) record.objective = update.objectiveAfter;
      update.status = "applied";
    } else {
      update.status = "rejected";
    }
    record.updatedAt = new Date().toISOString();
    this.persist(agentId);
    return structuredClone(record);
  }

  pending(agentId: string) {
    return (this.records.get(agentId)?.history ?? [])
      .filter((entry) => entry.status === "pending")
      .map((entry) => structuredClone(entry));
  }

  remove(agentId: string) {
    this.records.delete(agentId);
  }

  async flush() {
    await this.queue;
  }

  private persist(agentId: string) {
    const record = this.records.get(agentId);
    if (!record) return;
    const filePath = path.join(this.directory, agentId + ".json");
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
  }
}
