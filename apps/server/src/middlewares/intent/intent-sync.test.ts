import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { AuditStore } from "../audit/audit-store.js";
import { loadConfig } from "../../config.js";
import { codexRuntime } from "../../runtimes/codex.js";
import { JsonStore } from "../../store.js";
import { createRedactor } from "../trace/redaction.js";
import { TraceService } from "../trace/trace-service.js";
import { TraceStore } from "../trace/trace-store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import { WorkspaceManager } from "../../workspace.js";
import { IntentService } from "./intent-service.js";
import { IntentStore } from "./intent-store.js";

// The desync these tests exist for: agent.instructions is written to the
// workspace's AGENTS.md and is what the agent reads, while the intent record is
// what the auditor judges against. Editing one used to leave the other behind.

class IdleRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "done",
      threadId: request.threadId ?? "thread",
      usage: { inputTokens: 1, outputTokens: 1 },
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

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeApp() {
  const root = await mkdtemp(path.join(tmpdir(), "intent-sync-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new IdleRunner(),
  );
  await service.initialize();

  const traceStore = new TraceStore(path.join(root, "traces"));
  await traceStore.initialize();
  const auditStore = new AuditStore(path.join(root, "audits"));
  await auditStore.initialize();
  const intentStore = new IntentStore(path.join(root, "intent"));
  await intentStore.initialize();
  const intentService = new IntentService({
    store: intentStore,
    client: {
      complete: async () => {
        throw new Error("the classifier is not exercised here");
      },
    },
    model: "intent-model",
    // Off: these tests drive the instructions path, not classification.
    enabled: false,
  });

  const app = await createApp(config, service, {
    traceStore,
    auditStore,
    traceService: new TraceService(
      traceStore,
      createRedactor([]),
      codexRuntime.trace,
    ),
    intentService,
    collectorToken: "token",
  });

  cleanups.push(async () => {
    await app.close();
    await intentStore.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { app, root, intentService, intentStore };
}

async function createAgent(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  instructions: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "Builder", instructions },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ agent: { id: string; workspacePath: string } }>().agent;
}

function readIntent(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  agentId: string,
) {
  return app
    .inject({ method: "GET", url: "/api/agents/" + agentId + "/intent" })
    .then((response) =>
      response.json<{
        intent: { instructions: string; objective: string; extended: string[] };
        diverged: boolean;
        versions: { update?: { kind: string } }[];
      }>(),
    );
}

describe("instructions and the intent record", () => {
  it("starts an agent's record agreeing with the instructions it was created with", async () => {
    const { app } = await makeApp();
    const agent = await createAgent(app, "Build a todo list web application");

    const intent = await readIntent(app, agent.id);
    expect(intent.intent.instructions).toBe("Build a todo list web application");
    expect(intent.intent.objective).toBe("Build a todo list web application");
    expect(intent.diverged).toBe(false);
  });

  it("follows an instructions edit made through agent settings", async () => {
    const { app } = await makeApp();
    const agent = await createAgent(app, "Build a todo list web application");

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/agents/" + agent.id,
      payload: { instructions: "Build a calendar application" },
    });
    expect(patched.statusCode).toBe(200);

    // Before this wiring the agent followed the new instructions while the
    // auditor kept enforcing the old ones, with nothing reporting the split.
    const intent = await readIntent(app, agent.id);
    expect(intent.intent.instructions).toBe("Build a calendar application");
    expect(intent.intent.objective).toBe("Build a calendar application");
    expect(intent.versions.at(-1)?.update?.kind).toBe("instructions");

    const agentsMd = await readFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      "utf8",
    );
    expect(agentsMd).toContain("Build a calendar application");
  });

  it("does not touch the record when a PATCH leaves the instructions alone", async () => {
    const { app } = await makeApp();
    const agent = await createAgent(app, "Build a todo list web application");
    const before = (await readIntent(app, agent.id)).versions.length;

    await app.inject({
      method: "PATCH",
      url: "/api/agents/" + agent.id,
      payload: { name: "Renamed" },
    });

    expect((await readIntent(app, agent.id)).versions).toHaveLength(before);
  });

  it("adopts a diverged objective into the instructions and AGENTS.md", async () => {
    const { app, intentStore } = await makeApp();
    const agent = await createAgent(app, "Build a todo list web application");

    // What the classifier writes when the conversation pivots: a new objective
    // layered on top of instructions it deliberately leaves untouched.
    intentStore.append(agent.id, {
      instructions: "Build a todo list web application",
      objective: "Build a calendar application",
      extended: ["Do not read .env files."],
    });
    expect((await readIntent(app, agent.id)).diverged).toBe(true);

    const adopted = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/intent/adopt",
    });
    expect(adopted.statusCode).toBe(200);

    const intent = await readIntent(app, agent.id);
    expect(intent.diverged).toBe(false);
    expect(intent.intent.instructions).toBe("Build a calendar application");
    expect(intent.intent.objective).toBe("Build a calendar application");
    // Constraints gathered from the conversation survive the adoption.
    expect(intent.intent.extended).toEqual(["Do not read .env files."]);
    expect(intent.versions.at(-1)?.update?.kind).toBe("adopted");

    // The point of adopting: one source of truth, and the agent reads this file.
    const agentsMd = await readFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      "utf8",
    );
    expect(agentsMd).toContain("Build a calendar application");
  });

  it("refuses to adopt when the objective already matches the instructions", async () => {
    const { app } = await makeApp();
    const agent = await createAgent(app, "Build a todo list web application");

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + agent.id + "/intent/adopt",
    });
    expect(response.statusCode).toBe(409);
  });
});
