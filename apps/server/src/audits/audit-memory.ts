import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { auditTraceStepSchema, type AuditTraceStep } from "./audit-model.js";

// PLAN_AUDITOR's audit memory: one folder per chat holding a markdown record of
// every audited step plus a meta index.
//
//   agent-runs/{agentId}/{chatId}/{stepId}.md
//   agent-runs/{agentId}/{chatId}/steps-meta.json
//
// The markdown is what a person reads and what auditAll's backtrace re-reads for
// long-context handling; the meta index is what the analyses query. Both live on
// disk rather than in memory because a chat's audit outlives the process that
// produced it, and the archive download serves these files directly.

export const stepMetaEntrySchema = z.object({
  summary: z.string().default(""),
  findings: z.array(auditTraceStepSchema).default([]),
  error: z.string().default(""),
});

export type StepMetaEntry = z.infer<typeof stepMetaEntrySchema>;

export const stepsMetaSchema = z.record(z.string(), stepMetaEntrySchema);
export type StepsMeta = z.infer<typeof stepsMetaSchema>;

const META_FILE = "steps-meta.json";

// Span and agent ids are UUIDs, but a path is not the place to trust that.
function safeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128);
}

export class AuditMemory {
  // One promise chain per chat folder. PLAN_AUDITOR calls for a lock around the
  // meta update, and this is what a lock is here: steps are audited
  // concurrently, and steps-meta.json is a read-modify-write, so without
  // serialising them two steps finishing together lose one of the entries.
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  folderFor(agentId: string, chatId: string) {
    return path.join(this.root, safeSegment(agentId), safeSegment(chatId));
  }

  // Serialises work per chat folder and surfaces the result to the caller.
  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    // The chain must survive a failed task, or one bad write wedges the folder.
    this.locks.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async writeStep(
    agentId: string,
    chatId: string,
    stepId: string,
    markdown: string,
  ) {
    const folder = this.folderFor(agentId, chatId);
    return this.withLock(folder, async () => {
      try {
        await mkdir(folder, { recursive: true });
        await this.atomicWrite(
          path.join(folder, safeSegment(stepId) + ".md"),
          markdown,
        );
      } catch (error) {
        this.log?.("failed to write audit memory for step " + stepId, error);
      }
    });
  }

  async updateMeta(
    agentId: string,
    chatId: string,
    stepId: string,
    entry: StepMetaEntry,
  ) {
    const folder = this.folderFor(agentId, chatId);
    return this.withLock(folder, async () => {
      try {
        await mkdir(folder, { recursive: true });
        const meta = await this.readMetaUnlocked(folder);
        meta[stepId] = entry;
        await this.atomicWrite(
          path.join(folder, META_FILE),
          JSON.stringify(meta, null, 1) + "\n",
        );
      } catch (error) {
        this.log?.("failed to update audit meta for step " + stepId, error);
      }
    });
  }

  async readMeta(agentId: string, chatId: string): Promise<StepsMeta> {
    const folder = this.folderFor(agentId, chatId);
    return this.withLock(folder, () => this.readMetaUnlocked(folder));
  }

  // Every artifact file for a chat, for the archive download.
  async listArtifacts(agentId: string, chatId: string) {
    const folder = this.folderFor(agentId, chatId);
    try {
      const entries = await readdir(folder);
      return entries
        .filter((entry) => !entry.endsWith(".tmp"))
        .map((entry) => ({ name: entry, filePath: path.join(folder, entry) }));
    } catch {
      return [];
    }
  }

  // Waits for every in-flight write. Used at shutdown and by tests.
  async flush() {
    await Promise.all([...this.locks.values()]);
  }

  private async readMetaUnlocked(folder: string): Promise<StepsMeta> {
    try {
      const raw = await readFile(path.join(folder, META_FILE), "utf8");
      const parsed = stepsMetaSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      // No meta yet, or a file we cannot read: an empty index is the honest
      // answer and lets the next write rebuild it.
      return {};
    }
  }

  private async atomicWrite(filePath: string, contents: string) {
    const temporary = filePath + ".tmp";
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  }
}

// The per-step markdown record. Written for a reader first: what the step did,
// then what each check concluded about it.
export function renderStepMarkdown(input: {
  stepId: string;
  label: string;
  summary: string;
  findings: AuditTraceStep[];
  error: string;
}) {
  const lines = [
    "# Step " + input.stepId,
    "",
    "**Step:** " + input.label,
    "",
    "## Summary",
    "",
    input.summary || "(no summary produced)",
    "",
    "## Findings",
    "",
  ];
  if (input.findings.length === 0) {
    lines.push("None.");
  } else {
    for (const finding of input.findings) {
      lines.push(
        "- **" + finding.type + "** (" + finding.category + ") " + finding.finding,
      );
    }
  }
  if (input.error) {
    lines.push("", "## Audit error", "", input.error);
  }
  lines.push("");
  return lines.join("\n");
}
