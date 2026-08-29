import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditMemory, renderStepMarkdown } from "./audit-memory.js";
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
    });

    const meta = await memory.readMeta(AGENT, CHAT);
    expect(meta["step-1"]?.findings[0]?.finding).toContain("GITHUB_TOKEN");
    expect(meta["step-1"]?.findings[0]?.intentId).toBe("intent-1");
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
