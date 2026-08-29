import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  intentFileSchema,
  type IntentVersion,
  type IntentVersionEntry,
} from "./intent-model.js";

export class IntentStore {
  private readonly records = new Map<string, Map<string, IntentVersion>>();
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

  seed(agentId: string, objective: string, instructions = "") {
    const existing = this.records.get(agentId);
    if (existing && existing.size > 0) {
      const latest = existing.get([...existing.keys()].at(-1) ?? "");
      if (latest && latest.objective.length === 0 && objective.length > 0) {
        latest.objective = objective;
        if (latest.instructions.length === 0) latest.instructions = instructions;
        this.persist(agentId);
      }
      return;
    }
    const versions = new Map<string, IntentVersion>();
    versions.set(randomUUID(), {
      instructions,
      objective,
      extended: [],
      createdAt: new Date().toISOString(),
    });
    this.records.set(agentId, versions);
    this.persist(agentId);
  }

  // Mirrors an edit to agent.instructions into the record. Instructions are
  // what the agent actually follows — writeInstructions puts them in the
  // workspace's AGENTS.md — so an edit there used to leave the auditor judging
  // against a spec the agent had already stopped following.
  syncInstructions(
    agentId: string,
    instructions: string,
    // "adopted" when this edit came from writing a diverged objective back into
    // the instructions, so the timeline can tell the two apart.
    kind: "instructions" | "adopted" = "instructions",
  ) {
    const latest = this.latest(agentId);
    if (!latest) {
      this.seed(agentId, instructions, instructions);
      return null;
    }
    // PATCH fires on any field, so renaming an agent must not churn the
    // timeline with a version that changed nothing.
    if (latest.version.instructions === instructions) return null;

    // An objective that had been left to track the instructions keeps tracking
    // them. One the conversation deliberately moved away from is left where it
    // is: overwriting it here would silently discard a pivot the user made and
    // has not yet adopted.
    const wasInSync =
      latest.version.instructions.length === 0 ||
      latest.version.objective === latest.version.instructions;
    const previous = latest.version.instructions;

    // Clearing the instructions removes the base, not the goal. Letting the
    // objective follow an empty string to empty left the auditor with no spec
    // at all, silently falling back to whatever that run's prompt happened to
    // say — a much larger change than the operator asked for.
    const cleared = instructions.length === 0;
    const objective = cleared
      ? latest.version.objective
      : wasInSync
        ? instructions
        : latest.version.objective;

    return this.append(agentId, {
      instructions,
      objective,
      extended: [...latest.version.extended],
      update: {
        kind,
        logs: [
          kind === "adopted"
            ? "Adopted the objective into the agent's instructions"
            : cleared
              ? "Instructions cleared; the objective stands on its own"
              : previous.length > 0
                ? "Instructions changed from " + previous + " to " + instructions
                : "Instructions set to " + instructions,
        ],
        addedConstraints: [],
        removedConstraints: [],
        previousObjective:
          objective === latest.version.objective ? null : latest.version.objective,
        traceId: null,
        revertedFrom: null,
      },
    });
  }

  append(agentId: string, version: IntentVersion) {
    let versions = this.records.get(agentId);
    if (!versions) {
      versions = new Map();
      this.records.set(agentId, versions);
    }
    const intentId = randomUUID();
    versions.set(intentId, {
      instructions: version.instructions,
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
      // Deliberately NOT restored from the target. The instructions live in
      // agent settings and in the workspace's AGENTS.md, neither of which this
      // can rewrite — so writing a historical value here would have the record
      // claim the agent was told something it never was. Worse, the divergence
      // check compares these two fields, so restoring both together reported
      // "in sync" while the agent was reading something else entirely.
      //
      // Carrying the live value forward keeps the mirror honest, and a restored
      // objective that disagrees with it now shows up as the divergence it is.
      instructions: current?.version.instructions ?? target.instructions,
      objective: target.objective,
      extended: [...target.extended],
      update: {
        kind: "revert",
        logs: ["Reverted to version " + position],
        addedConstraints: [],
        // A revert restores a whole version rather than editing constraints one
        // at a time; the diff against what it replaced is the timeline's job.
        removedConstraints: [],
        previousObjective: current?.version.objective ?? null,
        traceId: null,
        revertedFrom: intentId,
      },
    });
  }

  remove(agentId: string) {
    this.records.delete(agentId);
    const filePath = path.join(this.directory, agentId + ".json");
    this.queue = this.queue
      .then(async () => {
        await Promise.all([
          rm(filePath, { force: true }),
          rm(filePath + ".tmp", { force: true }),
        ]);
      })
      .catch(() => undefined);
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
      .catch((error) =>
        this.log?.("failed to persist intent for agent " + agentId, error),
      );
  }
}
