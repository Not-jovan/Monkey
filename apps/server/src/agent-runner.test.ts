import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRuntimeRunner } from "./agent-runner.js";
import { loadConfig } from "./config.js";
import type { ParsedEvents, RuntimeDefinition } from "./runtimes/types.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace() {
  const directory = mkdtempSync(path.join(tmpdir(), "runner-"));
  directories.push(directory);
  return directory;
}

// A runtime whose "binary" is node itself, printing lines we control. The
// point is the runner's own contract — what it announces to its caller and
// when — which is otherwise only observable by spawning a real agent CLI.
function stubRuntime(lines: unknown[]): RuntimeDefinition {
  return {
    id: "codex",
    bin: () => process.execPath,
    homeDir: () => "/tmp/stub-home",
    homeEnvVar: "STUB_HOME",
    buildArgs: () => [
      "-e",
      lines
        .map((line) => "console.log(JSON.stringify(" + JSON.stringify(line) + "))")
        .join(";"),
    ],
    parseEventLine: (line: string, parsed: ParsedEvents) => {
      const raw = JSON.parse(line) as unknown;
      const event = (
        typeof raw === "string" ? JSON.parse(raw) : raw
      ) as Record<string, unknown>;
      if (typeof event.session === "string") parsed.threadId = event.session;
      if (typeof event.model === "string") parsed.model = event.model;
      if (typeof event.message === "string") parsed.messages.push(event.message);
    },
    async bootstrap() {},
    processEnv: () => ({}),
    trace: {
      runtimeId: "codex",
      displayName: "Stub",
      correlationAttribute: "conversation.id",
      normalize: () => null,
    },
  };
}

async function runWith(lines: unknown[], threadId: string | null = null) {
  const config = loadConfig({ NODE_ENV: "test" });
  const runner = new ProcessRuntimeRunner(config, stubRuntime(lines), "token");
  const threads: string[] = [];
  const models: string[] = [];
  const result = await runner.run({
    agentId: "agent-1",
    workspacePath: workspace(),
    prompt: "go",
    threadId,
    onThread: (thread) => threads.push(thread),
    onModel: (model) => models.push(model),
  });
  return { result, threads, models };
}

describe("ProcessRuntimeRunner", () => {
  // The trace pipeline binds a run's OTLP records on this id. Before it was
  // announced, a first run's telemetry correlated to nothing and expired
  // unattached, so the trace showed a prompt and no work at all.
  it("announces the conversation id as soon as the runtime names it", async () => {
    const { result, threads } = await runWith([
      { session: "session-abc", model: "test-model" },
      { message: "done" },
    ]);

    expect(threads).toEqual(["session-abc"]);
    expect(result.threadId).toBe("session-abc");
  });

  it("announces the model alongside it, exactly once", async () => {
    const { threads, models } = await runWith([
      { session: "session-abc", model: "test-model" },
      { model: "test-model" },
      { message: "done" },
    ]);

    expect(models).toEqual(["test-model"]);
    expect(threads).toEqual(["session-abc"]);
  });

  // A resumed run's id was already bound when the run started; re-announcing
  // it would be a second bind of the same pair.
  it("stays quiet when a resumed session keeps its id", async () => {
    const { threads } = await runWith(
      [{ session: "session-abc" }, { message: "done" }],
      "session-abc",
    );

    expect(threads).toEqual([]);
  });

  // The last line of a stream has no trailing newline, so it is parsed on a
  // separate path after the process closes. A short run can put everything
  // there.
  it("announces ids that only appear on the final unterminated line", async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const runtime = stubRuntime([]);
    runtime.buildArgs = () => [
      "-e",
      'process.stdout.write(JSON.stringify({session:"session-tail",model:"m",message:"done"}))',
    ];
    const runner = new ProcessRuntimeRunner(config, runtime, "token");
    const threads: string[] = [];
    const models: string[] = [];
    await runner.run({
      agentId: "agent-1",
      workspacePath: workspace(),
      prompt: "go",
      threadId: null,
      onThread: (thread) => threads.push(thread),
      onModel: (model) => models.push(model),
    });

    expect(threads).toEqual(["session-tail"]);
    expect(models).toEqual(["m"]);
  });
});
