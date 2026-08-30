import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// What an operator changed about an Agent's spec, and the evidence they were
// looking at when they changed it.
//
// This is a record of what happened, not a source of intent. The spec itself
// lives where it already lived before this store existed: on the Agent's
// instructions, which the auditor's reducer rebases onto every run. Nothing
// reads this store to decide what an Agent is for — it exists so a correction
// can be explained afterwards and undone.
export const intentCorrectionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  // The run whose findings prompted this. Kept so the UI can lead back to the
  // evidence rather than showing a constraint that arrived from nowhere.
  traceId: z.string(),
  // Every finding the operator selected. An array from the outset: one
  // correction usually answers several findings that are really one problem.
  findingIds: z.array(z.string()),
  correction: z.string(),
  // The instructions this replaced, which is what undoing it restores. Stored
  // rather than recomputed: the whole point of an undo is that it does not
  // depend on the state being reconstructible later.
  instructionsBefore: z.string(),
  createdAt: z.string(),
  // Undone corrections stay on the record. Removing them would make the
  // history claim the operator never made the call.
  revertedAt: z.string().nullable().default(null),
});

export type IntentCorrection = z.infer<typeof intentCorrectionSchema>;

const correctionFileSchema = z.array(intentCorrectionSchema);

// One file per Agent, holding its corrections oldest first.
//
// Writes are awaited rather than queued fire-and-forget. TraceStore takes the
// other choice deliberately, so a slow disk cannot stall a run — but a
// correction is an operator action whose whole value is that it was recorded,
// and the caller is an HTTP request that can afford to wait for the write.
export class IntentCorrectionStore {
  private readonly records = new Map<string, IntentCorrection[]>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    // Reports a correction that could not be read or written. Optional so a
    // test can stand the store up without one, matching TraceStore.
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      const agentId = entry.slice(0, -".json".length);
      try {
        this.records.set(
          agentId,
          correctionFileSchema.parse(
            JSON.parse(await readFile(path.join(this.directory, entry), "utf8")),
          ),
        );
      } catch (error) {
        // Loudly, unlike the audit store's silent skip: a correction that
        // cannot be read is an operator decision that has gone missing, and
        // nothing else in the system will notice it is absent.
        this.log?.("failed to read intent corrections for " + agentId, error);
      }
    }
  }

  // Oldest first, so the newest correction is the last entry — the one an undo
  // is allowed to target.
  list(agentId: string): IntentCorrection[] {
    return [...(this.records.get(agentId) ?? [])];
  }

  get(agentId: string, id: string): IntentCorrection | null {
    return this.records.get(agentId)?.find((entry) => entry.id === id) ?? null;
  }

  // The most recent correction still in force. Undo is offered for this one
  // alone: `instructionsBefore` describes the spec as it was immediately
  // before that edit, so restoring an older one would silently discard every
  // correction made after it.
  latestActive(agentId: string): IntentCorrection | null {
    const entries = this.records.get(agentId) ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry && entry.revertedAt === null) return entry;
    }
    return null;
  }

  async append(correction: IntentCorrection) {
    const entries = this.records.get(correction.agentId) ?? [];
    entries.push(correction);
    this.records.set(correction.agentId, entries);
    await this.persist(correction.agentId);
    return correction;
  }

  async markReverted(agentId: string, id: string, when: string) {
    const entry = this.get(agentId, id);
    if (!entry) return null;
    entry.revertedAt = when;
    await this.persist(agentId);
    return entry;
  }

  async flush() {
    await this.queue;
  }

  private async persist(agentId: string) {
    const filePath = path.join(this.directory, agentId + ".json");
    const snapshot = JSON.stringify(this.records.get(agentId) ?? [], null, 2);
    const operation = this.queue.then(async () => {
      const temporary = filePath + ".tmp";
      await writeFile(temporary, snapshot + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, filePath);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
