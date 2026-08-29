import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { codexRuntime } from "./runtimes/codex.js";
import { JsonStore } from "./store.js";
import { createRedactor } from "./traces/redaction.js";
import { TraceService } from "./traces/trace-service.js";
import { TraceStore } from "./traces/trace-store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  // Runtimes that resolve their model at run time report it here; Codex
  // leaves it null.
  constructor(private readonly model: string | null = null) {}
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
      model: this.model,
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  traces?: TraceService,
  envOverrides: Record<string, string> = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...envOverrides,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    traces,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null, model: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null, model: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("writes a terminate span onto the chat being stopped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const store = new TraceStore(path.join(root, "data", "traces"));
    await store.initialize();
    const traces = new TraceService(store, createRedactor([]), codexRuntime.trace);
    const service = await makeService(new FakeRunner(), traces);
    const agent = await service.createAgent({ name: "Stoppable" });
    const { run } = await service.sendMessage(agent.id, "write hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await service.stopAgent(agent.id);

    const trace = store.get(run.id);
    expect(trace?.spans.some((span) => span.name === "user.intervention")).toBe(
      true,
    );
    expect(
      trace?.spans.find((span) => span.name === "user.intervention")?.attributes
        .action,
    ).toBe("terminate");
  });
});

// The sidebar reads agentModel to say what the Agent is actually running on.
// It is not simply arkModel: Ark powers the audit models for every runtime,
// but only Codex's Agent.
describe("systemInfo agentModel", () => {
  it("reports the configured Ark model for codex", async () => {
    const service = await makeService();
    const info = await service.systemInfo();
    expect(info.agentRuntime).toBe("codex");
    expect(info.agentModel).toBe("ep-test");
  });

  it("reports no model for claude-code until a run has named one", async () => {
    const service = await makeService(new FakeRunner(), undefined, {
      AGENT_RUNTIME: "claude-code",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    const info = await service.systemInfo();
    expect(info.agentRuntime).toBe("claude-code");
    // Never the Ark endpoint — that runtime never calls it.
    expect(info.agentModel).toBeNull();
    expect(info.arkModel).toBe("ep-test");
  });

  it("reports the model a claude-code run observed", async () => {
    const service = await makeService(new FakeRunner("claude-opus-5[1m]"), undefined, {
      AGENT_RUNTIME: "claude-code",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    const agent = await service.createAgent({ name: "Builder" });
    const { run } = await service.sendMessage(agent.id, "build something");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const info = await service.systemInfo();
    expect(info.agentModel).toBe("claude-opus-5[1m]");
  });
});

// trace.model drives UsageBars on the trace detail page. Codex fills it from
// the OTLP conversation_starts event; Claude Code has no such event, so
// without the run-end handoff its traces showed no model at all.
describe("trace model handoff", () => {
  it("stamps a claude-code run's model onto its trace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const store = new TraceStore(path.join(root, "data", "traces"));
    await store.initialize();
    const traces = new TraceService(store, createRedactor([]), codexRuntime.trace);
    const service = await makeService(new FakeRunner("claude-opus-5[1m]"), traces, {
      AGENT_RUNTIME: "claude-code",
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "write hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(store.get(run.id)?.model).toBe("claude-opus-5[1m]");
  });

  it("leaves a model the trace already resolved alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const store = new TraceStore(path.join(root, "data", "traces"));
    await store.initialize();
    const traces = new TraceService(store, createRedactor([]), codexRuntime.trace);
    const service = await makeService(new FakeRunner("late-model"), traces);
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "write hello");
    // Stands in for Codex's authoritative conversation_starts value, which
    // arrives mid-run and must win over anything reported at the end.
    store.updateTrace(run.id, (trace) => {
      trace.model = "ep-authoritative";
    });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(store.get(run.id)?.model).toBe("ep-authoritative");
  });
});

// A run's OTLP records correlate on the id the runtime picks at run time, so
// the trace pipeline cannot bind them until the runner says what it is. When
// that handoff was missing, a first run's telemetry — every model call and
// every tool call — was buffered against an id nothing was listening for and
// then dropped.
describe("conversation handoff", () => {
  class RunnerThatNamesItsSession implements AgentRunner {
    async run(request: RunnerRequest): Promise<RunnerResult> {
      request.onThread?.("session-from-runtime");
      return {
        output: "done",
        threadId: "session-from-runtime",
        usage: null,
        model: null,
      };
    }
    async cancel(): Promise<boolean> {
      return false;
    }
    async isAvailable(): Promise<boolean> {
      return true;
    }
  }

  it("binds the trace to the session the runtime announces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const store = new TraceStore(path.join(root, "data", "traces"));
    await store.initialize();
    const traces = new TraceService(store, createRedactor([]), codexRuntime.trace);
    const service = await makeService(new RunnerThatNamesItsSession(), traces);
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "write hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(store.get(run.id)?.conversationId).toBe("session-from-runtime");
    // The binding is what makes a record land rather than buffer.
    expect(
      traces.ingestLogs({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      { key: "event.name", value: { stringValue: "codex.tool_result" } },
                      {
                        key: "conversation.id",
                        value: { stringValue: "session-from-runtime" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ buffered: 0 });
  });
});

// A run that fails never returns a RunnerResult, so a model carried only on
// the result was lost exactly when it mattered most — the trace for a failed
// run showed no model even though the runtime had announced one and it was
// sitting in the failure transcript. onModel reports it as soon as it is
// known, before the turn does any work.
describe("model reported by a failing run", () => {
  class FailingRunnerThatNamesItsModel implements AgentRunner {
    async run(request: RunnerRequest): Promise<RunnerResult> {
      request.onModel?.("claude-opus-5[1m]");
      throw new Error("Not logged in · Please run /login");
    }
    async cancel(): Promise<boolean> {
      return false;
    }
    async isAvailable(): Promise<boolean> {
      return true;
    }
  }

  it("keeps the model on the trace and in systemInfo after the run fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const store = new TraceStore(path.join(root, "data", "traces"));
    await store.initialize();
    const traces = new TraceService(store, createRedactor([]), codexRuntime.trace);
    const service = await makeService(
      new FailingRunnerThatNamesItsModel(),
      traces,
      { AGENT_RUNTIME: "claude-code", ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    const agent = await service.createAgent({ name: "Failing" });
    const { run } = await service.sendMessage(agent.id, "say hi");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    expect(store.get(run.id)?.model).toBe("claude-opus-5[1m]");
    expect((await service.systemInfo()).agentModel).toBe("claude-opus-5[1m]");
  });
});
