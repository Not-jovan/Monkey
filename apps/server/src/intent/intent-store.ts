import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  intentFileSchema,
  type IntentVersion,
  type IntentVersionEntry,
} from "./intent-model.js";

export class IntentStore {
  private readonly records = new Map<string, Map<string, IntentVersion>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const parsed = intentFileSchema.parse(
          JSON.parse(await readFile(path.join(this.directory, entry), "utf8")),
        );
        const agentId = entry.slice(0, -".json".length);
        this.records.set(agentId, new Map(Object.entries(parsed)));
      } catch {
        // Skip unreadable intent files rather than refusing to boot.
      }
    }
  }

  // Insertion order is the version order, and it is the only ordering there is:
  // ids are random UUIDs. Returned as a list rather than a record so the order
  // is carried explicitly instead of depending on object key order surviving
  // JSON in the browser.
  list(agentId: string): IntentVersionEntry[] {
    const versions = this.records.get(agentId);
    if (!versions) return [];
    return [...versions.entries()].map(([id, version]) => ({
      id,
      ...structuredClone(version),
    }));
  }

  latest(agentId: string) {
    const versions = this.records.get(agentId);
    if (!versions || versions.size === 0) return null;
    const intentId = [...versions.keys()].at(-1);
    if (!intentId) return null;
    const version = versions.get(intentId);
    if (!version) return null;
    return { intentId, version: structuredClone(version) };
  }

  get(agentId: string, intentId: string): IntentVersionEntry | null {
    const version = this.records.get(agentId)?.get(intentId);
    if (!version) return null;
    return { id: intentId, ...structuredClone(version) };
  }

  seed(agentId: string, objective: string) {
    const existing = this.records.get(agentId);
    if (existing && existing.size > 0) {
      const latest = existing.get([...existing.keys()].at(-1) ?? "");
      if (latest && latest.objective.length === 0 && objective.length > 0) {
        latest.objective = objective;
        this.persist(agentId);
      }
      return;
    }
    const versions = new Map<string, IntentVersion>();
    versions.set(randomUUID(), {
      objective,
      extended: [],
      createdAt: new Date().toISOString(),
    });
    this.records.set(agentId, versions);
    this.persist(agentId);
  }

  append(agentId: string, version: IntentVersion) {
    let versions = this.records.get(agentId);
    if (!versions) {
      versions = new Map();
      this.records.set(agentId, versions);
    }
    const intentId = randomUUID();
    versions.set(intentId, {
      objective: version.objective,
      extended: [...version.extended],
      createdAt: version.createdAt ?? new Date().toISOString(),
      ...(version.update ? { update: structuredClone(version.update) } : {}),
    });
    this.persist(agentId);
    return intentId;
  }

  // Restores an earlier version by appending a new one that carries its
  // content, never by rewinding the list. Audits pin the intentId they were
  // judged against and the trace UI resolves that id, so a version that has
  // been superseded still has to be readable — deleting history would make
  // every older trace point at nothing.
  revert(agentId: string, intentId: string) {
    const versions = this.records.get(agentId);
    const target = versions?.get(intentId);
    if (!versions || !target) return null;
    const current = this.latest(agentId);
    if (current?.intentId === intentId) return null;
    const position = [...versions.keys()].indexOf(intentId) + 1;
    return this.append(agentId, {
      objective: target.objective,
      extended: [...target.extended],
      update: {
        kind: "revert",
        logs: ["Reverted to version " + position],
        addedConstraints: [],
        previousObjective: current?.version.objective ?? null,
        traceId: null,
        revertedFrom: intentId,
      },
    });
  }

  remove(agentId: string) {
    this.records.delete(agentId);
  }

  async flush() {
    await this.queue;
  }

  private persist(agentId: string) {
    const versions = this.records.get(agentId);
    if (!versions) return;
    const filePath = path.join(this.directory, agentId + ".json");
    const snapshot = JSON.stringify(Object.fromEntries(versions), null, 1);
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
