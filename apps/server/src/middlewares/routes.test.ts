import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../agent-service.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { codexRuntime } from "../runtimes/codex.js";
import { createAuditMiddleware } from "./audit/index.js";
import type { AuditStore } from "./audit/audit-store.js";
import { createContextMiddleware } from "./context/index.js";
import { createTraceMiddleware, type TraceService } from "./trace/index.js";
import type { TraceStore } from "./trace/trace-store.js";
import { emptyUsage, type TraceRecord } from "./trace/trace-model.js";

const fixture = JSON.parse(
  await readFile(
    new URL("./trace/__fixtures__/otlp-logs.json", import.meta.url),
    "utf8",
  ),
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
      return {
        id,
        instructions: "Build a todo list web application",
      };
    },
    systemInfo: async () => ({}),
  } as unknown as AgentService;
  const directory = await mkdtemp(path.join(tmpdir(), "middleware-routes-"));
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: directory,
    ...environment,
  });
  const onStoreError = () => {};
  const log = () => {};
  // Auditing off: these tests write the findings they assert on directly into
  // the store, and a live auditor would queue a model call per completed run.
  const client = {
    complete: async () => ({
      content: "",
      usage: null,
      model: null,
      timing: {
        promptBytes: 0,
        inFlightAtStart: 0,
        headersMs: null,
        ttftMs: null,
        lastChunkMs: null,
        chunkCount: 0,
        requestId: null,
        abortPhase: null,
      },
    }),
  };

  const trace = await createTraceMiddleware({
    config,
    runtime: codexRuntime,
    onStoreError,
  });
  const context = await createContextMiddleware({
    config,
    traceStore: trace.traceStore,
    onStoreError,
  });
  const audit = await createAuditMiddleware({
    config,
    client,
    enabled: false,
    traceStore: trace.traceStore,
    traceService: trace.traceService,
    contextStore: context.contextStore,
    onStoreError,
    log,
    warn: () => {},
  });
  cleanups.push(async () => {
    await trace.flush();
    await context.flush();
    await audit.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  const app = await createApp(config, service, {
    traceStore: trace.traceStore,
    traceService: trace.traceService,
    auditStore: audit.auditStore,
    auditMemory: audit.auditMemory,
    contextService: context.contextService,
    collectorToken: "collector-token-1",
  });
  return {
    app,
    traceStore: trace.traceStore,
    traceService: trace.traceService,
    auditStore: audit.auditStore,
    auditMemory: audit.auditMemory,
    contextStore: context.contextStore,
  };
}

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EARLIER_RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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

function createCompletedTrace(
  traceStore: TraceStore,
  id: string,
  startedAt: string,
) {
  traceStore.create({
    version: 1,
    id,
    agentId: AGENT_ID,
    conversationId: null,
    status: "completed",
    startedAt,
    endedAt: startedAt,
    prompt: "count files",
    model: null,
    usage: emptyUsage(),
    failingSpanId: null,
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    auditOf: null,
    auditDepth: 0,
    spans: [],
  });
  return traceStore.get(id)!;
}

function pinDerivedIntent(
  auditStore: AuditStore,
  trace: NonNullable<ReturnType<TraceStore["get"]>>,
  objective: string,
  extended: string[] = [],
) {
  auditStore.recordIntent(trace, {
    state: { instructions: objective, objective, extended },
    addedConstraints: extended,
    removedConstraints: [],
    previousObjective: null,
    reason: "test",
    message: null,
    kind: extended.length > 0 ? "classified" : "seed",
  });
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
      auditedTraceId: string;
      auditTraceId: string | null;
      auditor: null;
      spans?: unknown;
    }>();
    expect(auditBody.auditedTraceId).toBe(RUN_ID);
    expect(auditBody.auditTraceId).toBeNull();
    expect(auditBody.auditor).toBeNull();
    expect(auditBody).not.toHaveProperty("spans");
    expect(auditBody).not.toHaveProperty("traceId");
    expect(detail.json()).not.toHaveProperty("auditorSpans");
    await app.close();
  });

  it("serves the auditor trace separately from the agent trace", async () => {
    const { app, traceStore } = await makeApp();
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
      auditOf: null,
      auditDepth: 0,
      spans: [],
    });
    // The auditor's work is a trace of its own, pointed at the run it judged.
    const AUDIT_TRACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    traceStore.create({
      version: 1,
      id: AUDIT_TRACE_ID,
      agentId: AGENT_ID,
      conversationId: null,
      status: "completed",
      startedAt: "2026-08-28T00:00:00.100Z",
      endedAt: "2026-08-28T00:00:00.400Z",
      prompt: "Audit of trace " + RUN_ID,
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
      auditOf: RUN_ID,
      auditDepth: 1,
      spans: [
        {
          id: "auditor-span-1",
          traceId: AUDIT_TRACE_ID,
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
    });

    const agentTrace = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID,
    });
    expect(agentTrace.statusCode).toBe(200);
    const agentBody = agentTrace.json<Record<string, unknown>>();
    expect(agentBody).not.toHaveProperty("auditorSpans");
    expect(agentBody).not.toHaveProperty("spans");
    expect(JSON.stringify(agentBody)).not.toContain("Step audit · Prompt");
    expect(agentBody.auditTraceId).toBe(AUDIT_TRACE_ID);

    const auditor = await app.inject({
      method: "GET",
      url: "/api/audits/" + RUN_ID,
    });
    expect(auditor.statusCode).toBe(200);
    const auditorBody = auditor.json<{
      auditedTraceId: string;
      auditTraceId: string;
      auditor: { id: string; auditOf: string | null; spans: { label: string; traceId: string; attributes: { context?: string } }[] };
      spans?: unknown;
    }>();
    expect(auditorBody.auditedTraceId).toBe(RUN_ID);
    expect(auditorBody.auditTraceId).toBe(AUDIT_TRACE_ID);
    expect(auditorBody).not.toHaveProperty("spans");
    expect(auditorBody.auditor.id).toBe(AUDIT_TRACE_ID);
    expect(auditorBody.auditor.auditOf).toBe(RUN_ID);
    expect(auditorBody.auditor.spans).toHaveLength(1);
    expect(auditorBody.auditor.spans[0]?.label).toBe("Step audit · Prompt");
    expect(auditorBody.auditor.spans[0]?.traceId).toBe(AUDIT_TRACE_ID);
    expect(auditorBody.auditor.spans[0]?.attributes.context).toContain("cat .env");

    // The auditor's run shares the agent's id, because it is about that agent —
    // but it is not a run of the Agent, so it is not in the Agent's run list.
    // You reach it by opening the run it judged.
    const runs = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces",
    });
    const listed = runs.json<{ traces: { id: string }[] }>().traces;
    expect(listed.map((entry) => entry.id)).toContain(RUN_ID);
    expect(listed.map((entry) => entry.id)).not.toContain(AUDIT_TRACE_ID);

    const missing = await app.inject({
      method: "GET",
      url: "/api/audits/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(missing.statusCode).toBe(404);
  });
  it("serves intent history from per-audit derivations", async () => {
    const { app, auditStore, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    const objective = "Build a todo list web application";
    const earlier = createCompletedTrace(
      traceStore,
      EARLIER_RUN_ID,
      "2026-08-28T00:00:00.000Z",
    );
    const latest = createCompletedTrace(
      traceStore,
      RUN_ID,
      "2026-08-28T01:00:00.000Z",
    );
    pinDerivedIntent(auditStore, earlier, objective);
    pinDerivedIntent(auditStore, latest, objective, ["Do not read .env files."]);

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
    expect(body.intent.objective).toBe(objective);
    expect(body.intent.extended).toEqual(["Do not read .env files."]);
    expect(body.intentId).toBe(RUN_ID);
    expect(body.versions.map((entry) => entry.id)).toEqual([
      EARLIER_RUN_ID,
      RUN_ID,
    ]);
    expect(body.versions.at(-1)?.extended).toEqual(["Do not read .env files."]);
    expect(body).not.toHaveProperty("pending");
    expect(body).not.toHaveProperty("requiresConfirmation");

    const gone = await app.inject({
      method: "POST",
      url: "/api/agents/" + AGENT_ID + "/intent/revert",
      payload: { intentId: RUN_ID },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("includes the derived intent on a trace", async () => {
    const { app, auditStore, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    const trace = createCompletedTrace(
      traceStore,
      RUN_ID,
      "2026-08-28T00:00:00.000Z",
    );
    pinDerivedIntent(auditStore, trace, "Build a todo list web application", [
      "Do not read .env files.",
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      intent: {
        instructions: string;
        objective: string;
        extended: string[];
      } | null;
    }>();
    expect(body).not.toHaveProperty("intentId");
    expect(body.intent?.objective).toBe("Build a todo list web application");
    expect(body.intent?.extended).toEqual(["Do not read .env files."]);
    expect(body.intent).not.toHaveProperty("stale");
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
        auditOf: null,
        auditDepth: 0,
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
        auditOf: null,
        auditDepth: 0,
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

  // The archive is the only way the audit memory leaves the server, so the
  // route has to carry the files the step audits wrote and not just the audit
  // document. It shipped serving an always-empty memory/ folder because
  // nothing wrote to the memory at all.
  it("streams the audit memory alongside the audit document", async () => {
    const { app, traceService, auditMemory } = await makeApp();
    startRun(traceService);
    await auditMemory.writeStep(
      AGENT_ID,
      RUN_ID,
      "span-1",
      ["# Step span-1", "", "Ran ls and listed the workspace.", ""].join("\n"),
    );
    await auditMemory.updateMeta(AGENT_ID, RUN_ID, "span-1", {
      summary: "Ran ls and listed the workspace.",
      findings: [],
      error: "",
    });
    await auditMemory.flush();

    const response = await app.inject({
      method: "GET",
      url: "/api/audits/" + RUN_ID + "/archive",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    const zip = response.rawPayload;
    // Local file headers name every entry, which is enough to assert what the
    // archive carries without unzipping it.
    const names: string[] = [];
    const localFileHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    for (
      let at = zip.indexOf(localFileHeader);
      at !== -1;
      at = zip.indexOf(localFileHeader, at + 4)
    ) {
      const length = zip.readUInt16LE(at + 26);
      names.push(zip.subarray(at + 30, at + 30 + length).toString());
    }
    expect(names).toContain("memory/span-1.md");
    expect(names).toContain("memory/steps-meta.json");
    expect(names).toContain("audit.json");
  });

  // A suspicion is a question the auditor could not settle, not a claim that
  // the agent did something wrong. Folding it into the warning count made the
  // row state exactly what the severity exists to avoid stating.
  it("counts suspicions apart from warnings on a trace row", async () => {
    const { app, traceStore, traceService, auditStore } = await makeApp();
    startRun(traceService);
    const trace = traceStore.get(RUN_ID);
    expect(trace).toBeTruthy();
    if (!trace) return;
    const finding = (type: "warning" | "suspicion", id: string) => ({
      id,
      traceId: RUN_ID,
      agentId: AGENT_ID,
      spanId: null,
      intentId: "",
      type,
      category: "intent-check" as const,
      finding: id,
    });
    auditStore.recordRun(
      trace,
      [
        finding("warning", "confirmed"),
        finding("suspicion", "unsettled-one"),
        finding("suspicion", "unsettled-two"),
      ],
      "",
      "",
      "ok",
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces",
    });
    const body = response.json<{
      traces: { warningCount: number; suspicionCount: number }[];
    }>();
    expect(body.traces[0]?.warningCount).toBe(1);
    expect(body.traces[0]?.suspicionCount).toBe(2);
  });
});

describe("Agent trace routes", () => {
  const denied = {
    layer: "policy" as const,
    kind: "sandbox-denied",
    retryability: "user-action" as const,
    title: "The Runtime sandbox denied this operation",
    detail: "listen EPERM",
    remedy: "Keep the work inside /workspace.",
    exitCode: 1,
  };
  const commandFailed = {
    layer: "agent" as const,
    kind: "tool-failed",
    retryability: "transient" as const,
    title: "A command the agent wrote failed",
    detail: "npm ERR! missing script",
    remedy: "Read the failing step.",
    exitCode: 1,
  };

  function seedFailed(
    traceStore: TraceStore,
    id: string,
    startedAt: string,
    failure: typeof denied | typeof commandFailed,
    extra: {
      auditOf?: string;
      failingSpanId?: string | null;
      spans?: TraceRecord["spans"];
    } = {},
  ) {
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
      usage: emptyUsage(),
      failingSpanId: extra.failingSpanId ?? extra.spans?.[0]?.id ?? null,
      failure,
      recoveredErrorCount: 0,
      evidenceComplete: true,
      unrecognizedEvents: 0,
      auditOf: extra.auditOf ?? null,
      auditDepth: extra.auditOf ? 1 : 0,
      spans: extra.spans ?? [],
    });
  }

  it("serves a compressed index that leaves the human listing unchanged", async () => {
    const { app, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    seedFailed(traceStore, RUN_ID, "2026-08-28T00:00:00.000Z", commandFailed, {
      spans: [
        {
          id: "shell-1",
          traceId: RUN_ID,
          parentId: null,
          name: "tool.shell",
          label: "Tool · npm test",
          kind: "tool_call",
          actor: "agent",
          status: "error",
          startedAt: "2026-08-28T00:00:00.000Z",
          endedAt: "2026-08-28T00:00:01.000Z",
          durationMs: 1_000,
          attributes: { output: "npm ERR! missing script: test" },
          error: "npm ERR!",
        },
      ],
    });

    const human = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces",
    });
    const listed = human.json<{ traces: { id: string; prompt: string }[] }>();
    expect(listed.traces[0]).not.toHaveProperty("diagnosis");
    expect(listed.traces[0]?.prompt).toBe("serve on port 8080");

    const ai = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces/ai",
    });
    expect(ai.statusCode).toBe(200);
    const body = ai.json<{
      traces: {
        id: string;
        diagnosis: { blame: string; kind: string; evidence?: string } | null;
      }[];
    }>();
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.diagnosis?.blame).toBe("agent");
    expect(body.traces[0]?.diagnosis?.kind).toBe("tool-failed");
    expect(body.traces[0]?.diagnosis).not.toHaveProperty("evidence");
  });

  it("filters the agent index by blame", async () => {
    const { app, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    seedFailed(traceStore, RUN_ID, "2026-08-28T00:00:00.000Z", commandFailed);
    seedFailed(
      traceStore,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "2026-08-28T00:01:00.000Z",
      denied,
    );

    const agentOnly = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/traces/ai?blame=agent",
    });
    const body = agentOnly.json<{ traces: { id: string }[] }>();
    expect(body.traces.map((row) => row.id)).toEqual([RUN_ID]);
  });

  it("groups failures for agents without counting auditor runs", async () => {
    const { app, traceStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    seedFailed(traceStore, RUN_ID, "2026-08-28T00:00:00.000Z", commandFailed);
    seedFailed(
      traceStore,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "2026-08-28T00:01:00.000Z",
      commandFailed,
      { auditOf: RUN_ID },
    );

    const human = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/failures",
    });
    expect(
      human.json<{ failures: { count: number }[] }>().failures[0]?.count,
    ).toBe(2);

    const ai = await app.inject({
      method: "GET",
      url: "/api/agents/" + AGENT_ID + "/failures/ai",
    });
    const body = ai.json<{
      failures: {
        kind: string;
        blamesAgent: boolean;
        count: number;
        detail: string;
        traceIds: string[];
      }[];
    }>();
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]?.count).toBe(1);
    expect(body.failures[0]?.blamesAgent).toBe(true);
    expect(body.failures[0]?.detail).toBe(commandFailed.detail);
    expect(body.failures[0]?.traceIds).toEqual([RUN_ID]);
  });

  it("serves a case file instead of the span dump", async () => {
    const { app, traceStore, auditStore } = await makeApp();
    cleanups.push(async () => {
      await app.close();
    });
    seedFailed(traceStore, RUN_ID, "2026-08-28T00:00:00.000Z", commandFailed, {
      failingSpanId: "shell-1",
      spans: [
        {
          id: "run",
          traceId: RUN_ID,
          parentId: null,
          name: "agent.run",
          label: "Run",
          kind: "run",
          actor: "system",
          status: "error",
          startedAt: "2026-08-28T00:00:00.000Z",
          endedAt: "2026-08-28T00:00:01.000Z",
          durationMs: 1_000,
          attributes: {},
          error: null,
        },
        {
          id: "shell-1",
          traceId: RUN_ID,
          parentId: "run",
          name: "tool.shell",
          label: "Tool · npm test",
          kind: "tool_call",
          actor: "agent",
          status: "error",
          startedAt: "2026-08-28T00:00:00.000Z",
          endedAt: "2026-08-28T00:00:01.000Z",
          durationMs: 1_000,
          attributes: {
            arguments: JSON.stringify({ command: "npm test" }),
            output: "npm ERR! missing script: test",
          },
          error: "npm ERR!",
        },
      ],
    });
    const stored = traceStore.get(RUN_ID);
    expect(stored).toBeTruthy();
    if (stored) {
      auditStore.recordRun(
        stored,
        [
          {
            id: "finding-1",
            traceId: RUN_ID,
            agentId: AGENT_ID,
            spanId: "shell-1",
            intentId: "",
            type: "warning",
            category: "intent-check",
            finding: "The test script is missing.",
          },
        ],
        "",
        "",
        "ok",
      );
    }

    const human = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID,
    });
    expect(human.json<{ trace: { spans: unknown[] } }>().trace.spans).toHaveLength(
      2,
    );

    const ai = await app.inject({
      method: "GET",
      url: "/api/traces/" + RUN_ID + "/ai",
    });
    expect(ai.statusCode).toBe(200);
    const body = ai.json<{
      id: string;
      diagnosis: { blame: string; evidence: string } | null;
      failingStep: { commands: string[] } | null;
      trajectory: string[];
      findings: { span: { label: string } | null }[];
      trace?: unknown;
      spans?: unknown;
    }>();
    expect(body.id).toBe(RUN_ID);
    expect(body).not.toHaveProperty("trace");
    expect(body).not.toHaveProperty("spans");
    expect(body.diagnosis?.blame).toBe("agent");
    expect(body.failingStep?.commands).toEqual(["npm test"]);
    expect(body.trajectory.some((line) => line.includes("Tool · npm test"))).toBe(
      true,
    );
    expect(body.trajectory.some((line) => line.includes("Run"))).toBe(false);
    expect(body.findings[0]?.span?.label).toBe("Tool · npm test");
  });
});
