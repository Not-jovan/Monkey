import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { auditTraceStepSchema, type AuditTraceStep } from "./audit-model.js";
import { cachedCheckSchema } from "./step-check-cache.js";

// PLAN_AUDITOR's audit memory: one folder per chat holding a markdown record of
// every audited step plus a meta index.
//
//   agent-runs/{agentId}/{chatId}/{stepId}.md
//   agent-runs/{agentId}/{chatId}/steps-meta.json
//
// The markdown is the auditor's workpad: durable per-step memory that auditAll
// re-reads after the step is gone. The meta index says which of those files to
// open. Both live on disk because a chat's audit outlives the process that
// produced it. The archive zips them on request; they are not a stored zip.

export const stepMetaEntrySchema = z.object({
  summary: z.string().default(""),
  findings: z.array(auditTraceStepSchema).default([]),
  error: z.string().default(""),
  // Per-check outcomes so a retry can skip completed/degraded calls and only
  // re-ask the ones that failed. Defaulted so older workpads still parse.
  checks: z.record(z.string(), cachedCheckSchema).optional(),
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
    // Public because the chat auditor reports its own memoryFolderPath, which
    // is this root plus its identity.
    readonly root: string,
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

  async readStep(agentId: string, chatId: string, stepId: string) {
    const files = await this.readSteps(agentId, chatId, [stepId]);
    return files.get(stepId) ?? null;
  }

  // One lock for the whole set so auditAll sees a consistent workpad, not a
  // mix of files from before and after a concurrent step write.
  async readSteps(agentId: string, chatId: string, stepIds: string[]) {
    const folder = this.folderFor(agentId, chatId);
    return this.withLock(folder, async () => {
      const files = new Map<string, string>();
      for (const stepId of stepIds) {
        try {
          const markdown = await readFile(
            path.join(folder, safeSegment(stepId) + ".md"),
            "utf8",
          );
          files.set(stepId, markdown);
        } catch {
          // The index can point at a step whose markdown never landed. Callers
          // fall back to the meta entry rather than dropping the step.
        }
      }
      return files;
    });
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

// What auditAll actually reads from a workpad file. Starts at the summary so
// the heading does not eat the clip budget. Falls back to the index summary
// when the markdown is missing.
export function workpadExcerpt(
  markdown: string | null | undefined,
  fallback: string,
) {
  const source = markdown?.trim() || fallback.trim();
  if (!source) return "";
  const start = source.indexOf("## Summary");
  const body = start === -1 ? source : source.slice(start);
  const flat = body.replace(/\s+/g, " ").trim();
  const limit = 600;
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit) + " …";
}

// The per-step markdown record. The workpad auditAll re-reads: what the step
// did, then what each check concluded about it.
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
