import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../agent-service.js";
import { AuditStore } from "../audits/audit-store.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { ContextService } from "../context/context-service.js";
import { ContextStore } from "../context/context-store.js";
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
  });
  const contextStore = new ContextStore(path.join(directory, "context"));
  await contextStore.initialize();
  cleanups.push(async () => {
    await contextStore.flush();
  });
  const traceService = new TraceService(traceStore, createRedactor([]));
  const contextService = new ContextService({
    traceStore,
    store: contextStore,
  });
  contextService.start();
  const app = await createApp(
    loadConfig({ NODE_ENV: "test", ...environment }),
    service,
    {
      traceStore,
      auditStore,
      traceService,
      intentService,
      contextService,
      collectorToken: "collector-token-1",
    },
  );
  return {
    app,
    traceStore,
    auditStore,
    traceService,
    intentStore,
    intentService,
    contextStore,
  };
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
    expect(listed).not.toHaveProperty("lifecycle");

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
    expect(downloadedBody).toHaveProperty("intent");
    await app.close();
  });
  it("serves the current intent versions map", async () => {
    const { app, intentStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    intentStore.seed(AGENT_ID, "Build a todo list web application");
    const intentId = intentStore.append(AGENT_ID, {
      objective: "Build a todo list web application",
      extended: ["Do not read .env files."],
      update: {
        kind: "classified",
        logs: ["Do not read .env files.", "prohibition"],
        addedConstraints: ["Do not read .env files."],
        previousObjective: null,
        traceId: null,
        revertedFrom: null,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/intent",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      intent: { objective: string; extended: string[] };
      versions: { id: string; objective: string; extended: string[] }[];
      intentId: string | null;
    }>();
    expect(body.intent.objective).toBe("Build a todo list web application");
    expect(body.intent.extended).toEqual(["Do not read .env files."]);
    expect(body.intentId).toBe(intentId);
    // Ordered, so position in the list is the version number a reader sees.
    expect(body.versions.map((entry) => entry.id).at(-1)).toBe(intentId);
    expect(body.versions.at(-1)?.extended).toEqual(["Do not read .env files."]);
    expect(body).not.toHaveProperty("pending");
    expect(body).not.toHaveProperty("requiresConfirmation");

    const gone = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/intent/" + intentId,
      payload: { decision: "confirm" },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("includes the pinned intent on a trace", async () => {
    const { app, auditStore, intentStore, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    intentStore.seed(AGENT_ID, "Build a todo list web application");
    const firstId = intentStore.latest(AGENT_ID)?.intentId ?? "";
    intentStore.append(AGENT_ID, {
      objective: "Build a todo list web application",
      extended: ["Do not read .env files."],
    });

    traceStore.create({
      version: 1,
      id: RUN_ID,
      agentId: AGENT_ID,
      conversationId: null,
      status: "completed",
      startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: "2026-08-28T00:00:01.000Z",
      prompt: "count files",
      model: null,
      usage: {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        toolTokens: 0,
      },
      failingSpanId: null,
      failure: null,
      recoveredErrorCount: 0,
      evidenceComplete: true,
      unrecognizedEvents: 0,
      spans: [],
    });
    const trace = traceStore.get(RUN_ID);
    expect(trace).toBeTruthy();
    if (!trace) return;
    auditStore.recordRun(trace, [], "", firstId, "ok");

    const response = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      intentId: string | null;
      intent: {
        id: string;
        objective: string;
        extended: string[];
        stale: boolean;
      } | null;
    }>();
    expect(body.intentId).toBe(firstId);
    expect(body.intent?.id).toBe(firstId);
    expect(body.intent?.objective).toBe("Build a todo list web application");
    expect(body.intent?.extended).toEqual([]);
    expect(body.intent?.stale).toBe(true);
  });

  // Reverting appends; it must never rewind, or an audit that pinned the
  // reverted-away-from version would resolve to nothing.
  it("restores an earlier intent version without erasing history", async () => {
    const { app, intentStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    intentStore.seed(AGENT_ID, "Build a todo list web application");
    const seedId = intentStore.latest(AGENT_ID)?.intentId ?? "";
    const updatedId = intentStore.append(AGENT_ID, {
      objective: "Build a todo list web application",
      extended: ["Do not read .env files."],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/intent/revert",
      payload: { intentId: seedId },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      intent: { extended: string[] };
      versions: { id: string; update?: { revertedFrom: string | null } }[];
      intentId: string | null;
    }>();
    expect(body.intent.extended).toEqual([]);
    expect(body.versions).toHaveLength(3);
    expect(body.versions.at(-1)?.update?.revertedFrom).toBe(seedId);
    expect(body.versions.map((entry) => entry.id)).toContain(updatedId);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/intent/revert",
      payload: { intentId: "not-a-version" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("serves prior context and the thread position with a trace", async () => {
    const { app, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });

    const seed = (id: string, startedAt: string) => {
      traceStore.create({
        version: 1,
        id,
        agentId: AGENT_ID,
        conversationId: "thread-1",
        status: "running",
        startedAt,
        endedAt: null,
        prompt: "document the install flow",
        model: null,
        usage: {
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolTokens: 0,
        },
        failingSpanId: null,
        failure: null,
        recoveredErrorCount: 0,
        evidenceComplete: true,
        unrecognizedEvents: 0,
        spans: [],
      });
      traceStore.updateTrace(id, (trace) => {
        trace.status = "completed";
        trace.endedAt = startedAt;
      });
    };

    seed(RUN_ID, "2026-08-28T00:00:00.000Z");
    seed("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2026-08-28T00:01:00.000Z");

    const response = await app.inject({
      method: "GET",
      url: "/api/traces/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      auditHealth: string;
      context: {
        position: number;
        chainLength: number;
        previousTraceId: string | null;
        carriedIn: { summary: string; source: string } | null;
      } | null;
    }>();
    // No auditor ran at all here, which is exactly the case that used to leave
    // prior context empty.
    expect(body.auditHealth).toBe("ok");
    expect(body.context?.position).toBe(2);
    expect(body.context?.chainLength).toBe(2);
    expect(body.context?.previousTraceId).toBe(RUN_ID);
    expect(body.context?.carriedIn?.source).toBe("derived");
    expect(body.context?.carriedIn?.summary).toContain("document the install flow");
  });

  it("groups an agent's failures by kind", async () => {
    const { app, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });

    const denied = {
      layer: "policy" as const,
      kind: "sandbox-denied",
      retryability: "user-action" as const,
      title: "The Runtime sandbox denied this operation",
      detail: "listen EPERM",
      remedy: "Keep the work inside /workspace.",
      exitCode: 1,
    };
    for (const [id, startedAt] of [
      [RUN_ID, "2026-08-28T00:00:00.000Z"],
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2026-08-28T00:01:00.000Z"],
    ] as const) {
      traceStore.create({
        version: 1,
        id,
        agentId: AGENT_ID,
        conversationId: "thread-1",
        status: "failed",
        startedAt,
        endedAt: startedAt,
        prompt: "serve on port 8080",
        model: null,
        usage: {
          inputTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          toolTokens: 0,
        },
        failingSpanId: null,
        failure: denied,
        recoveredErrorCount: 0,
        evidenceComplete: true,
        unrecognizedEvents: 0,
        spans: [],
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/failures",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      failures: { kind: string; layer: string; count: number }[];
    }>();
    // One failure is an incident; the same one twice is the thing to fix.
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]?.kind).toBe("sandbox-denied");
    expect(body.failures[0]?.layer).toBe("policy");
    expect(body.failures[0]?.count).toBe(2);
  });
});
