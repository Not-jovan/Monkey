import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSnapshot,
  type IntentChatRef,
  type IntentRecord,
  type IntentSnapshot,
  type IntentUpdate,
} from "./intent-model.js";

const MAX_HISTORY = 200;

function chatFromUpdate(update: IntentUpdate): IntentChatRef | null {
  if (!update.messageId || !update.traceId) return null;
  return { messageId: update.messageId, traceId: update.traceId };
}

function hydrate(raw: IntentRecord): IntentRecord | null {
  if (raw.version !== 1) return null;
  raw.extended = raw.extended ?? [];
  raw.history = (raw.history ?? []).map((entry) => ({
    ...entry,
    messageId: entry.messageId ?? null,
    traceId: entry.traceId ?? null,
  }));
  raw.lastModifiedBy = raw.lastModifiedBy ?? null;
  raw.states = raw.states ?? [];
  if (raw.states.length === 0) {
    raw.states.push(
      createSnapshot({
        objective: raw.objective,
        extended: raw.extended,
        lastModifiedBy: raw.lastModifiedBy,
        traces: [],
        at: raw.updatedAt,
      }),
    );
  }
  return raw;
}

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
        const parsed: unknown = JSON.parse(
          await readFile(path.join(this.directory, entry), "utf8"),
        );
        if (!isIntentRecord(parsed)) continue;
        const raw = hydrate(parsed);
        if (raw) this.records.set(raw.agentId, raw);
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
  ensure(
    agentId: string,
    objective: string,
    chat?: IntentChatRef,
  ): IntentRecord {
    const existing = this.records.get(agentId);
    if (existing) {
      if (existing.objective.length === 0 && objective.length > 0) {
        existing.objective = objective;
        existing.updatedAt = new Date().toISOString();
        const latest = latestSnapshot(existing);
        if (latest && latest.objective.length === 0)
          latest.objective = objective;
        if (chat) this.markModified(existing, chat);
        this.persist(agentId);
      }
      return structuredClone(existing);
    }
    const at = new Date().toISOString();
    const lastModifiedBy = chat ?? null;
    const record: IntentRecord = {
      version: 1,
      agentId,
      objective,
      extended: [],
      updatedAt: at,
      lastModifiedBy,
      states: [
        createSnapshot({
          objective,
          extended: [],
          lastModifiedBy,
          traces: chat ? [chat.traceId] : [],
          at,
        }),
      ],
      history: [],
    };
    this.records.set(agentId, record);
    this.persist(agentId);
    return structuredClone(record);
  }

  // Records that this run proceeded under the current spec. Does not count as
  // a modification — lastModifiedBy only moves when apply/resolve changes it.
  noteChat(agentId: string, chat: IntentChatRef) {
    const stored = this.records.get(agentId);
    if (!stored) return;
    rememberTrace(latestSnapshot(stored), chat.traceId);
    this.persist(agentId);
  }

  apply(agentId: string, update: IntentUpdate): IntentRecord {
    this.ensure(agentId, "");
    const stored = this.records.get(agentId);
    if (!stored) return this.ensure(agentId, "");
    const normalized: IntentUpdate = {
      ...update,
      messageId: update.messageId ?? null,
      traceId: update.traceId ?? null,
    };
    if (normalized.status === "applied") {
      this.commitSpec(stored, normalized);
    }
    stored.history.push(normalized);
    trim(stored.history);
    stored.updatedAt = normalized.at;
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
      this.commitSpec(record, update);
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

  private commitSpec(stored: IntentRecord, update: IntentUpdate) {
    for (const entry of update.added) {
      if (!stored.extended.includes(entry)) stored.extended.push(entry);
    }
    if (update.objectiveAfter) stored.objective = update.objectiveAfter;
    const chat = chatFromUpdate(update);
    const previous = latestSnapshot(stored);
    if (previous && chat) {
      previous.traces = previous.traces.filter((id) => id !== chat.traceId);
    }
    stored.states.push(
      createSnapshot({
        objective: stored.objective,
        extended: stored.extended,
        lastModifiedBy: chat ?? stored.lastModifiedBy,
        traces: chat ? [chat.traceId] : [],
        at: update.at,
      }),
    );
    trim(stored.states);
    if (chat) stored.lastModifiedBy = chat;
  }

  private markModified(stored: IntentRecord, chat: IntentChatRef) {
    stored.lastModifiedBy = chat;
    const latest = latestSnapshot(stored);
    if (!latest) return;
    latest.lastModifiedBy = chat;
    rememberTrace(latest, chat.traceId);
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

function latestSnapshot(record: IntentRecord): IntentSnapshot | undefined {
  return record.states[record.states.length - 1];
}

function rememberTrace(snapshot: IntentSnapshot | undefined, traceId: string) {
  if (!snapshot) return;
  if (!snapshot.traces.includes(traceId)) snapshot.traces.push(traceId);
}

function trim<T>(items: T[]) {
  if (items.length > MAX_HISTORY) items.splice(0, items.length - MAX_HISTORY);
}

function isIntentRecord(value: unknown): value is IntentRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || !("agentId" in value)) return false;
  return value.version === 1 && typeof value.agentId === "string";
}
