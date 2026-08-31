import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "./middlewares/trace/redaction.js";
import {
  runtimeEventFilePath,
  runtimeEventStatePath,
  startRuntimeEventPipeline,
} from "./runtime-event-scraper.js";
import type { RuntimeEventStreamProblem } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-event-scraper-"));
  temporaryDirectories.push(root);
  return root;
}

function isTerminalEvent(event: Record<string, unknown>): boolean {
  return event.type === "turn.completed";
}

describe("Runtime event scraper", () => {
  it("reassembles partial JSONL lines and checkpoints the terminal event", async () => {
    const root = await makeRoot();
    const seen: string[] = [];

    const pipeline = await startRuntimeEventPipeline({
      dataDirectory: root,
      runId: "run-1",
      onEvent: async (event) => {
        seen.push(String(event.type));
      },
      isTerminalEvent,
    });

    pipeline.record('{"type":"thread.started"}\n{"type":"turn.com');
    await expect.poll(() => [...seen]).toEqual(["thread.started"]);

    pipeline.record('pleted"}');
    await pipeline.close();

    expect(seen).toEqual(["thread.started", "turn.completed"]);

    const stored = JSON.parse(
      await readFile(runtimeEventStatePath(root, "run-1"), "utf8"),
    ) as {
      ptr: number;
      done: boolean;
      partialLine: string;
    };
    expect(stored.done).toBe(true);
    expect(stored.partialLine).toBe("");
    expect(stored.ptr).toBe(
      Buffer.byteLength('{"type":"thread.started"}\n{"type":"turn.completed"}\n'),
    );
  });

  it("marks the run corrupted when the event file is truncated", async () => {
    const root = await makeRoot();
    const seen: string[] = [];
    let problem: RuntimeEventStreamProblem | null = null;

    const pipeline = await startRuntimeEventPipeline({
      dataDirectory: root,
      runId: "run-2",
      onEvent: async (event) => {
        seen.push(String(event.type));
      },
      onProblem: async (next) => {
        problem = next;
      },
      isTerminalEvent,
    });

    pipeline.record('{"type":"thread.started"}\n');
    await expect.poll(() => [...seen]).toEqual(["thread.started"]);

    await writeFile(runtimeEventFilePath(root, "run-2"), "", "utf8");
    await expect.poll(() => problem?.reason ?? null).toBe(
      "Runtime event file was truncated or replaced",
    );

    await pipeline.close();

    const stored = JSON.parse(
      await readFile(runtimeEventStatePath(root, "run-2"), "utf8"),
    ) as {
      ptr: number;
      done: boolean;
      partialLine: string;
    };
    expect(stored.done).toBe(true);
    expect(stored.ptr).toBe(Buffer.byteLength('{"type":"thread.started"}\n'));
  });

  it("marks the run corrupted and does not advance past malformed JSONL", async () => {
    const root = await makeRoot();
    const seen: string[] = [];
    let problem: RuntimeEventStreamProblem | null = null;

    const pipeline = await startRuntimeEventPipeline({
      dataDirectory: root,
      runId: "run-3",
      onEvent: async (event) => {
        seen.push(String(event.type));
      },
      onProblem: async (next) => {
        problem = next;
      },
      isTerminalEvent,
    });

    pipeline.record('{"type":"thread.started"}\n{"type":\n');
    await expect.poll(() => problem?.reason ?? null).toContain(
      "Malformed runtime JSONL event",
    );

    await pipeline.close();

    expect(seen).toEqual(["thread.started"]);

    const stored = JSON.parse(
      await readFile(runtimeEventStatePath(root, "run-3"), "utf8"),
    ) as {
      ptr: number;
      done: boolean;
      partialLine: string;
    };
    expect(stored.done).toBe(true);
    expect(stored.ptr).toBe(Buffer.byteLength('{"type":"thread.started"}\n'));
  });

  it("redacts secrets before events.jsonl is written, including split chunks", async () => {
    const root = await makeRoot();
    const secret = "ark-PIPELINE-FAKE-SECRET-0000001";
    const seen: Record<string, unknown>[] = [];
    const pipeline = await startRuntimeEventPipeline({
      dataDirectory: root,
      runId: "run-redacted",
      onEvent: (event) => {
        seen.push(event);
      },
      isTerminalEvent,
      redact: createRedactor([secret]).redactText,
    });

    const event = JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "export ARK_API_KEY=" + secret,
      },
    });
    const split = event.indexOf(secret) + 8;
    pipeline.record(event.slice(0, split));
    pipeline.record(event.slice(split) + "\n");
    await pipeline.close();

    const persisted = await readFile(
      runtimeEventFilePath(root, "run-redacted"),
      "utf8",
    );
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("***");
    expect(persisted).toContain("_launchpadSecretTypes");
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(seen[0]?._launchpadSecretTypes).toEqual(["ARK_API_KEY"]);
  });
});
