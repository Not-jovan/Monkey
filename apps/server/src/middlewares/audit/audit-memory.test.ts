import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditMemory, renderStepMarkdown, workpadExcerpt } from "./audit-memory.js";
import type { AuditTraceStep } from "./audit-model.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeMemory() {
  const root = await mkdtemp(path.join(tmpdir(), "audit-memory-"));
  const memory = new AuditMemory(path.join(root, "agent-runs"));
  cleanups.push(async () => {
    await memory.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { memory, root };
}

function finding(overrides: Partial<AuditTraceStep> = {}): AuditTraceStep {
  return {
    id: "audit-1#1",
    traceId: "chat-1",
    agentId: "agent-1",
    spanId: "step-1",
    intentId: "intent-1",
    type: "warning",
    category: "security",
    finding: "GITHUB_TOKEN was sent outward",
    ...overrides,
  };
}

const AGENT = "agent-1";
const CHAT = "chat-1";

describe("AuditMemory", () => {
  it("writes one markdown file per step under agent-runs/{agentId}/{chatId}", async () => {
    const { memory } = await makeMemory();
    await memory.writeStep(AGENT, CHAT, "step-1", "# Step step-1\n");

    const file = path.join(
      memory.folderFor(AGENT, CHAT),
      "step-1.md",
    );
    expect(await readFile(file, "utf8")).toContain("step-1");
    expect(memory.folderFor(AGENT, CHAT)).toContain(path.join(AGENT, CHAT));
  });

  it("does not lose entries when steps finish at the same time", async () => {
    const { memory } = await makeMemory();

    // steps-meta.json is a read-modify-write, and steps are audited
    // concurrently. Without the lock the later write reads a copy from before
    // the earlier one landed and silently drops it.
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        memory.updateMeta(AGENT, CHAT, "step-" + index, {
          summary: "did thing " + index,
          findings: [],
          error: "",
        }),
      ),
    );

    const meta = await memory.readMeta(AGENT, CHAT);
    expect(Object.keys(meta)).toHaveLength(12);
    expect(meta["step-7"]?.summary).toBe("did thing 7");
  });

  it("round-trips findings through the meta index", async () => {
    const { memory } = await makeMemory();
    await memory.updateMeta(AGENT, CHAT, "step-1", {
      summary: "read .env",
      findings: [finding()],
      error: "",
      checks: {
        summary: {
          applicable: true,
          status: "completed",
          failure: null,
          label: "Summarize",
          verdict: { summary: "read .env" },
        },
      },
    });

    const meta = await memory.readMeta(AGENT, CHAT);
    expect(meta["step-1"]?.findings[0]?.finding).toContain("GITHUB_TOKEN");
    expect(meta["step-1"]?.findings[0]?.intentId).toBe("intent-1");
    expect(meta["step-1"]?.checks?.summary?.status).toBe("completed");
  });

  it("reports an empty index rather than throwing when nothing was written", async () => {
    const { memory } = await makeMemory();
    expect(await memory.readMeta(AGENT, "never-audited")).toEqual({});
    expect(await memory.listArtifacts(AGENT, "never-audited")).toEqual([]);
  });

  it("lists the artifacts an archive should contain, excluding temp files", async () => {
    const { memory } = await makeMemory();
    await memory.writeStep(AGENT, CHAT, "step-1", "# one");
    await memory.writeStep(AGENT, CHAT, "step-2", "# two");
    await memory.updateMeta(AGENT, CHAT, "step-1", {
      summary: "",
      findings: [],
      error: "",
    });

    const names = (await memory.listArtifacts(AGENT, CHAT))
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(["step-1.md", "step-2.md", "steps-meta.json"]);
  });

  it("reads the workpad files the index points at", async () => {
    const { memory } = await makeMemory();
    await memory.writeStep(AGENT, CHAT, "step-1", "# one\n\n## Summary\n\ndid one\n");
    await memory.writeStep(AGENT, CHAT, "step-2", "# two\n\n## Summary\n\ndid two\n");

    expect(await memory.readStep(AGENT, CHAT, "step-1")).toContain("did one");
    const files = await memory.readSteps(AGENT, CHAT, ["step-1", "step-2", "missing"]);
    expect(files.get("step-2")).toContain("did two");
    expect(files.has("missing")).toBe(false);
    expect(await memory.readStep(AGENT, CHAT, "missing")).toBeNull();
  });

  it("reports a write it could not make instead of swallowing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "audit-memory-bad-"));
    const failures: string[] = [];
    // A file where the folder needs to be: mkdir fails with ENOTDIR every time.
    await (await import("node:fs/promises")).writeFile(
      path.join(root, "blocker"),
      "not a directory",
      "utf8",
    );
    const memory = new AuditMemory(path.join(root, "blocker", "runs"), (message) =>
      failures.push(message),
    );
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });

    await memory.writeStep(AGENT, CHAT, "step-1", "# one");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("step-1");
  });
});

describe("renderStepMarkdown", () => {
  it("leads with what the step did, then what the checks concluded", () => {
    const markdown = renderStepMarkdown({
      stepId: "step-1",
      label: "Tool · exec_command",
      summary: "Read .env and printed the database password.",
      findings: [finding()],
      error: "",
    });
    expect(markdown).toContain("**Step:** Tool · exec_command");
    expect(markdown).toContain("Read .env");
    expect(markdown).toContain("**warning** (security)");
  });

  it("says so plainly when a step produced no findings", () => {
    const markdown = renderStepMarkdown({
      stepId: "step-2",
      label: "Tool · read",
      summary: "Listed the workspace.",
      findings: [],
      error: "",
    });
    expect(markdown).toContain("None.");
  });
});

describe("workpadExcerpt", () => {
  it("starts at the summary so the heading does not eat the clip", () => {
    const markdown = renderStepMarkdown({
      stepId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      label: "Tool · exec_command",
      summary: "Posted the contents of .env to example.com.",
      findings: [],
      error: "",
    });
    const excerpt = workpadExcerpt(markdown, "fallback");
    expect(excerpt.startsWith("## Summary")).toBe(true);
    expect(excerpt).toContain("Posted the contents of .env");
    expect(excerpt).not.toContain("aaaaaaaa-bbbb");
  });

  it("falls back to the index summary when the markdown is missing", () => {
    expect(workpadExcerpt(null, "read .env")).toBe("read .env");
  });
});

// The run-level pass reads its open questions from this index and has no other
// source for them, so an index lost here takes the backtrace with it. An empty
// answer is still the right one — auditing with less beats refusing to audit —
// but it must not be the same silence as a run that simply had no steps.
describe("AuditMemory step index failures", () => {
  async function memoryWithLog() {
    const root = await mkdtemp(path.join(tmpdir(), "audit-memory-"));
    const messages: string[] = [];
    const memory = new AuditMemory(path.join(root, "agent-runs"), (message) =>
      messages.push(message),
    );
    cleanups.push(async () => {
      await memory.flush();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    return { memory, messages };
  }

  it("says nothing when there is simply no index yet", async () => {
    const { memory, messages } = await memoryWithLog();

    expect(await memory.readMeta("agent-1", "chat-1")).toEqual({});
    expect(messages).toEqual([]);
  });

  it("reports an index that exists and will not parse", async () => {
    const { memory, messages } = await memoryWithLog();
    const folder = memory.folderFor("agent-1", "chat-1");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "steps-meta.json"), "{not json", "utf8");

    expect(await memory.readMeta("agent-1", "chat-1")).toEqual({});
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("steps-meta.json");
  });

  it("reports an index whose shape is wrong", async () => {
    const { memory, messages } = await memoryWithLog();
    const folder = memory.folderFor("agent-1", "chat-1");
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "steps-meta.json"),
      JSON.stringify({ "span-1": "not an entry" }),
      "utf8",
    );

    expect(await memory.readMeta("agent-1", "chat-1")).toEqual({});
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("did not parse");
  });
});
