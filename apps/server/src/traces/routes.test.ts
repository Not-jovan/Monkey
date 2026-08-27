import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../agent-service.js";
import { AuditStore } from "../audits/audit-store.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { IntentService } from "../intent/intent-service.js";
import { IntentStore } from "../intent/intent-store.js";
import { createRedactor } from "./redaction.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const fixture = JSON.parse(
  await readFile(new URL("./__fixtures__/otlp-logs.json", import.meta.url), "utf8"),
) as unknown;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function makeApp(environment: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "glassbox-routes-"));
  const traceStore = new TraceStore(path.join(directory, "traces"));
  await traceStore.initialize();
  const auditStore = new AuditStore(path.join(directory, "audits"));
  await auditStore.initialize();
  cleanups.push(async () => {
    await traceStore.flush();
    await auditStore.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const intentStore = new IntentStore(path.join(directory, "intent"));
  await intentStore.initialize();
  cleanups.push(async () => {
    await intentStore.flush();
  });
  const intentService = new IntentService({
    store: intentStore,
    client: { complete: async () => ({ content: "" }) },
    model: "intent-model",
    enabled: false,
    requireConfirmation: true,
  });
  const traceService = new TraceService(traceStore, createRedactor([]));
  const app = await createApp(
    loadConfig({ NODE_ENV: "test", ...environment }),
    service,
    {
      traceStore,
      auditStore,
      traceService,
      intentService,
      collectorToken: "collector-token-1",
    },
  );
  return { app, traceStore, auditStore, traceService, intentStore, intentService };
}

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function startRun(traceService: TraceService) {
  traceService.onRunStart(
    {
      id: AGENT_ID,
      name: "Builder",
      instructions: "",
      codexThreadId: "01a03e52-a697-79a1-b344-15a234416b01",
    },
    { id: RUN_ID, prompt: "count files" },
  );
}

describe("Glassbox routes", () => {
  it("accepts OTLP posts only with the per-boot collector token", async () => {
    const { app, traceStore, traceService } = await makeApp();
    startRun(traceService);

    const noToken = await app.inject({
      method: "POST",
      url: "/collector/v1/logs",
      payload: fixture as Record<string, unknown>,
    });
    expect(noToken.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "POST",
      url: "/collector/v1/logs",
      headers: { "x-collector-token": "guess" },
      payload: fixture as Record<string, unknown>,
    });
    expect(wrongToken.statusCode).toBe(401);

    const accepted = await app.inject({
      method: "POST",
      url: "/collector/v1/logs",
      headers: { "x-collector-token": "collector-token-1" },
      payload: fixture as Record<string, unknown>,
    });
    expect(accepted.statusCode).toBe(200);
    expect(traceStore.get(RUN_ID)?.spans.length).toBeGreaterThan(2);

    const garbage = await app.inject({
      method: "POST",
      url: "/collector/v1/logs",
      headers: {
        "x-collector-token": "collector-token-1",
        "content-type": "application/json",
      },
      payload: '"not-otlp"',
    });
    expect(garbage.statusCode).toBe(400);
    await app.close();
  });

  it("keeps the collector reachable when the operator API requires auth", async () => {
    const { app, traceService } = await makeApp({
      APP_AUTH_TOKEN: "a-strong-test-token",
    });
    startRun(traceService);

    const collector = await app.inject({
      method: "POST",
      url: "/collector/v1/logs",
      headers: { "x-collector-token": "collector-token-1" },
      payload: fixture as Record<string, unknown>,
    });
    expect(collector.statusCode).toBe(200);

    const traces = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces",
    });
    expect(traces.statusCode).toBe(401);
    await app.close();
  });

  it("serves trace listings, details and exports", async () => {
    const { app, traceService } = await makeApp();
    startRun(traceService);
    traceService.ingestLogs(fixture);
    traceService.onRunEnd(RUN_ID, { status: "completed" });

    const listing = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces",
    });
    expect(listing.statusCode).toBe(200);
    const listed = listing.json<{
      traces: { id: string; warningCount: number; spanCount: number }[];
    }>();
    expect(listed.traces).toHaveLength(1);
    expect(listed.traces[0]?.id).toBe(RUN_ID);

    const detail = await app.inject({ method: "GET", url: "/api/traces/" + RUN_ID });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{
      trace: { spans: unknown[] };
      findings: unknown[];
    }>();
    expect(body.trace.spans.length).toBeGreaterThan(2);
    expect(body.findings).toEqual([]);

    const missing = await app.inject({
      method: "GET",
      url: "/api/traces/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(missing.statusCode).toBe(404);

    const exported = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID + "/export",
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("trace-" + RUN_ID);

    const downloaded = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID + "/download",
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-disposition"]).toContain(
      "trace-" + RUN_ID,
    );
    const downloadedBody = downloaded.json<{
      trace: { id: string; spans: { kind: string; attributes: Record<string, string | number | boolean> }[] };
    }>();
    expect(downloadedBody.trace.id).toBe(RUN_ID);
    const model = downloadedBody.trace.spans.find(
      (span) => span.kind === "model_call",
    );
    expect(String(model?.attributes.context)).toContain("count files");
    expect(String(model?.attributes.output)).toContain("exec_command");
    await app.close();
  });
  it("serves the current intent and resolves a pending update", async () => {
    const { app, intentStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    intentStore.ensure(AGENT_ID, "Build a todo list web application");
    const updateId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    intentStore.apply(AGENT_ID, {
      id: updateId,
      at: "2026-08-27T00:00:00.000Z",
      message: "Do not read .env files.",
      reason: "prohibition",
      added: ["Do not read .env files."],
      objectiveBefore: null,
      objectiveAfter: null,
      status: "pending",
    });

    const before = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/intent",
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as {
      intent: { objective: string; extended: string[] };
      pending: { id: string }[];
      requiresConfirmation: boolean;
    };
    expect(beforeBody.intent.objective).toBe("Build a todo list web application");
    expect(beforeBody.intent.extended).toEqual([]);
    expect(beforeBody.pending).toHaveLength(1);
    expect(beforeBody.requiresConfirmation).toBe(true);

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/intent/" + updateId,
      payload: { decision: "confirm" },
    });
    expect(confirmed.statusCode).toBe(200);
    const confirmedBody = confirmed.json() as {
      intent: { extended: string[] };
      pending: unknown[];
    };
    expect(confirmedBody.intent.extended).toEqual(["Do not read .env files."]);
    expect(confirmedBody.pending).toEqual([]);

    // Resolving twice is a 404, not a silent second application.
    const again = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/intent/" + updateId,
      payload: { decision: "confirm" },
    });
    expect(again.statusCode).toBe(404);
  });
});
