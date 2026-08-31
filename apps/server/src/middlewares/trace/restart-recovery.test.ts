import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config.js";
import { codexRuntime } from "../../runtimes/codex.js";
import { runtimeEventFilePath } from "../../runtime-event-scraper.js";
import { createTraceMiddleware } from "./index.js";
import { emptyUsage, type TraceRecord } from "./trace-model.js";
import { TraceStore } from "./trace-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-restart-"));
  temporaryDirectories.push(root);
  return root;
}

function fakeConfig(dataDirectory: string): AppConfig {
  return {
    dataDirectory,
    arkApiKey: "",
    authToken: "",
    anthropicApiKey: "",
    claudeCodeOauthToken: "",
  } as unknown as AppConfig;
}

// A trace that was mid-run when the process crashed: the scraper had already
// flagged the event stream as disrupted (evidenceComplete: false), but the
// run never reached onRunEnd, so it is still "running" with no endedAt.
function crashedTrace(input: {
  id: string;
  agentId: string;
  rootSpanId: string;
  promptSpanId: string;
  startedAt: string;
}): TraceRecord {
  return {
    version: 1,
    id: input.id,
    agentId: input.agentId,
    conversationId: null,
    status: "running",
    startedAt: input.startedAt,
    endedAt: null,
    prompt: "run the demo command",
    model: null,
    usage: emptyUsage(),
    failingSpanId: null,
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: false,
    evidenceProblem: "Runtime event stream disrupted",
    unrecognizedEvents: 0,
    auditOf: null,
    auditDepth: 0,
    runtimeEvents: [],
    spans: [
      {
        id: input.rootSpanId,
        traceId: input.id,
        parentId: null,
        name: "agent.run",
        label: "Agent run · TestAgent",
        kind: "run",
        actor: "agent",
        status: "running",
        startedAt: input.startedAt,
        endedAt: null,
        durationMs: null,
        attributes: {
          agentId: input.agentId,
          agentName: "TestAgent",
          instructions: "",
        },
        error: null,
      },
      {
        id: input.promptSpanId,
        traceId: input.id,
        parentId: input.rootSpanId,
        name: "user.prompt",
        label: 'Prompt "run the demo command"',
        kind: "user_action",
        actor: "user",
        status: "ok",
        startedAt: input.startedAt,
        endedAt: input.startedAt,
        durationMs: 0,
        attributes: {
          prompt: "run the demo command",
          promptLength: "run the demo command".length,
        },
        error: null,
      },
    ],
  };
}

describe("trace middleware restart recovery", () => {
  it("replays persisted runtime events, restores evidenceComplete, and fires trace-completed exactly once", async () => {
    const root = await makeRoot();
    const runId = randomUUID();
    const agentId = randomUUID();
    const rootSpanId = randomUUID();
    const promptSpanId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000).toISOString();

    await mkdir(path.join(root, "traces"), { recursive: true });
    await writeFile(
      path.join(root, "traces", runId + ".json"),
      JSON.stringify(
        crashedTrace({ id: runId, agentId, rootSpanId, promptSpanId, startedAt }),
        null,
        1,
      ) + "\n",
      "utf8",
    );

    // What the runner had already written to durable evidence before the
    // process died: a full command execution followed by an agent message
    // and the turn's terminal event.
    const events = [
      {
        type: "item.started",
        item: { id: "cmd-1", type: "command_execution", command: "echo hi" },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "echo hi",
          aggregated_output: "hi\n",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "All done" },
      },
      { type: "turn.completed" },
    ];
    const eventFilePath = runtimeEventFilePath(root, runId);
    await mkdir(path.dirname(eventFilePath), { recursive: true });
    await writeFile(
      eventFilePath,
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );

    // createTraceMiddleware runs its recovery sweep synchronously (awaited)
    // before returning, so any listener attached to the returned traceStore
    // would miss it. Spy on the prototype instead, which is in place before
    // the instance is even constructed.
    const emitSpy = vi.spyOn(TraceStore.prototype, "emit");

    const errors: unknown[] = [];
    const middleware = await createTraceMiddleware({
      config: fakeConfig(root),
      runtime: codexRuntime,
      onStoreError: (message, error) => errors.push({ message, error }),
    });

    expect(errors).toEqual([]);

    const traceCompletedCalls = emitSpy.mock.calls.filter(
      (call) => call[0] === "trace-completed",
    );
    expect(traceCompletedCalls).toHaveLength(1);

    const trace = middleware.traceStore.get(runId);
    expect(trace).not.toBeNull();
    expect(trace!.evidenceComplete).toBe(true);
    expect(trace!.evidenceProblem).toBeNull();
    expect(trace!.status).not.toBe("running");
    expect(trace!.runtimeEvents).toHaveLength(events.length);

    const toolSpan = trace!.spans.find((span) => span.name === "tool.exec_command");
    expect(toolSpan?.status).toBe("ok");
    expect(toolSpan?.attributes.output).toContain("hi");

    const modelSpan = trace!.spans.find((span) => span.kind === "model_call");
    expect(modelSpan?.attributes.output).toBe("All done");

    await middleware.flush();
  });
});
