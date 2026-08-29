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
import { HttpError } from "../errors.js";
import { createRedactor } from "./redaction.js";
import { codexRuntime } from "../runtimes/codex.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

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
  const agents = new Set([AGENT_ID]);
  const service = {
    listAgents: () => [],
    getAgent: (id: string) => {
      if (!agents.has(id)) throw new HttpError(404, "Agent not found");
      return { id };
    },
    systemInfo: async () => ({}),
  } as unknown as AgentService;
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
  const traceService = new TraceService(
    traceStore,
    createRedactor([]),
    codexRuntime.trace,
  );
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
    agents,
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
    expect(downloadedBody).not.toHaveProperty("spans");
    expect(body).not.toHaveProperty("spans");

    const audit = await app.inject({
      method: "GET",
      url: "/api/audits/" + RUN_ID,
    });
    expect(audit.statusCode).toBe(200);
    const auditBody = audit.json<{
      traceId: string;
      spans: unknown[];
    }>();
    expect(auditBody.traceId).toBe(RUN_ID);
    expect(auditBody.spans).toEqual([]);
    expect(detail.json()).not.toHaveProperty("auditorSpans");
    await app.close();
  });

  it("serves the auditor trace separately from the agent trace", async () => {
    const { app, auditStore, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
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
    auditStore.appendAuditorSpans(
      trace,
      [
        {
          id: "auditor-span-1",
          traceId: RUN_ID,
          parentId: null,
          name: "audit.step",
          label: "Step audit · Prompt",
          kind: "model_call",
          actor: "system",
          status: "ok",
          startedAt: "2026-08-28T00:00:00.100Z",
          endedAt: "2026-08-28T00:00:00.400Z",
          durationMs: 300,
          attributes: {
            model: "sec-model",
            context: "## Step under audit\ncat .env",
            output: '{"dangerous":false}',
            phase: "step",
            targetSpanId: "span-1",
          },
          error: null,
        },
      ],
      "",
    );

    const agentTrace = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID,
    });
    expect(agentTrace.statusCode).toBe(200);
    const agentBody = agentTrace.json<Record<string, unknown>>();
    expect(agentBody).not.toHaveProperty("auditorSpans");
    expect(agentBody).not.toHaveProperty("spans");
    expect(JSON.stringify(agentBody)).not.toContain("Step audit · Prompt");

    const auditor = await app.inject({
      method: "GET",
      url: "/api/audits/" + RUN_ID,
    });
    expect(auditor.statusCode).toBe(200);
    const auditorBody = auditor.json<{
      traceId: string;
      agentId: string;
      spans: { label: string; attributes: { context?: string } }[];
    }>();
    expect(auditorBody.traceId).toBe(RUN_ID);
    expect(auditorBody.agentId).toBe(AGENT_ID);
    expect(auditorBody.spans).toHaveLength(1);
    expect(auditorBody.spans[0]?.label).toBe("Step audit · Prompt");
    expect(auditorBody.spans[0]?.attributes.context).toContain("cat .env");

    const missing = await app.inject({
      method: "GET",
      url: "/api/audits/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(missing.statusCode).toBe(404);
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

  it("turns an audited finding into a human-authored intent constraint", async () => {
    const { app, traceService, traceStore, auditStore, intentStore, agents } =
      await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    intentStore.seed(AGENT_ID, "Write installation documentation");
    startRun(traceService);
    traceService.onRunEnd(RUN_ID, { status: "completed" });
    const trace = traceStore.get(RUN_ID)!;

    const beforeAudit = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingId: "finding-network-1",
        correction: "Do not contact hosts outside the configured whitelist.",
      },
    });
    expect(beforeAudit.statusCode).toBe(409);
    expect(beforeAudit.json<{ error: string }>().error).toContain(
      "audit to finish",
    );

    auditStore.recordRun(
      trace,
      [
        {
          id: "finding-network-1",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: null,
          type: "warning",
          category: "security",
          finding:
            "Contacted github.com, which is outside the configured whitelist.",
        },
        {
          id: "finding-retry-2",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: null,
          type: "warning",
          category: "reliability",
          finding: "Repeated the same failed network operation.",
        },
      ],
      "",
      intentStore.latest(AGENT_ID)?.intentId ?? "",
    );

    const activeRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    traceService.onRunStart(
      {
        id: AGENT_ID,
        name: "Builder",
        instructions: "",
        codexThreadId: null,
      },
      { id: activeRunId, prompt: "A newer task" },
    );
    const duringActiveRun = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingIds: ["finding-network-1", "finding-retry-2"],
        correction: "Do not contact hosts outside the configured whitelist.",
      },
    });
    expect(duringActiveRun.statusCode).toBe(409);
    expect(duringActiveRun.json<{ error: string }>().error).toContain(
      "active run",
    );
    traceService.onRunEnd(activeRunId, { status: "completed" });

    const applied = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingIds: ["finding-network-1", "finding-retry-2"],
        correction: "Do not contact hosts outside the configured whitelist.",
      },
    });
    expect(applied.statusCode).toBe(201);
    const body = applied.json<{
      intent: { extended: string[] };
      versions: {
        update?: {
          kind: string;
          sources?: { findingId: string; spanId: string | null }[];
          traceId: string | null;
        };
      }[];
    }>();
    expect(body.intent.extended).toContain(
      "Do not contact hosts outside the configured whitelist.",
    );
    expect(body.versions.at(-1)?.update).toMatchObject({
      kind: "human-correction",
      sources: [
        { findingId: "finding-network-1", spanId: null },
        { findingId: "finding-retry-2", spanId: null },
      ],
      traceId: RUN_ID,
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingIds: ["finding-retry-2"],
        correction: "Try to apply it twice.",
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const invented = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingId: "not-real",
        correction: "Do not accept findings invented by the browser.",
      },
    });
    expect(invented.statusCode).toBe(404);

    auditStore.recordRun(
      trace,
      [
        {
          id: "finding-secret-2",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: null,
          type: "warning",
          category: "security",
          finding: "A credential was sent to an unrelated service.",
        },
      ],
      "",
      intentStore.latest(AGENT_ID)?.intentId ?? "",
    );
    const secret = "ghp_example_secret";
    const masked = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingId: "finding-secret-2",
        correction: "Never send " + secret + " to unrelated services.",
      },
    });
    expect(masked.statusCode).toBe(201);
    expect(masked.body).not.toContain(secret);
    expect(masked.body).toContain("ghp");

    auditStore.recordRun(
      trace,
      [
        {
          id: "finding-auditor-health",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: null,
          type: "error",
          category: "audit-health",
          finding: "The auditor could not complete.",
        },
        {
          id: "finding-missing-span",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: "span-that-does-not-exist",
          type: "warning",
          category: "reliability",
          finding: "The agent repeated a failed command.",
        },
        {
          id: "finding-related-3",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: null,
          type: "warning",
          category: "security",
          finding: "A related security warning.",
        },
      ],
      "",
      intentStore.latest(AGENT_ID)?.intentId ?? "",
    );
    const auditorHealth = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingIds: ["finding-related-3", "finding-auditor-health"],
        correction: "Change the Agent because its auditor was unavailable.",
      },
    });
    expect(auditorHealth.statusCode).toBe(400);
    expect(
      intentStore
        .latest(AGENT_ID)
        ?.version.update?.sources?.some(
          (source) => source.findingId === "finding-related-3",
        ),
    ).not.toBe(true);

    const missingSpan = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingId: "finding-missing-span",
        correction: "Change approach before retrying a failed command.",
      },
    });
    expect(missingSpan.statusCode).toBe(404);

    auditStore.recordRun(
      trace,
      [
        {
          id: "finding-after-delete",
          traceId: RUN_ID,
          agentId: AGENT_ID,
          spanId: null,
          type: "warning",
          category: "reliability",
          finding: "The agent repeated a failed command.",
        },
      ],
      "",
      intentStore.latest(AGENT_ID)?.intentId ?? "",
    );
    agents.delete(AGENT_ID);
    const deletedAgent = await app.inject({
      method: "POST",
      url: "/api/traces/" + RUN_ID + "/intent/correct",
      payload: {
        findingId: "finding-after-delete",
        correction: "Change approach before retrying a failed command.",
      },
    });
    expect(deletedAgent.statusCode).toBe(404);
    expect(deletedAgent.json<{ error: string }>().error).toBe("Agent not found");
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
