import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditStore } from "../audits/audit-store.js";
import { blamesAgent } from "../failures.js";
import type { ContextService } from "../context/context-service.js";
import type { IntentService } from "../intent/intent-service.js";
import { HttpError } from "../errors.js";
import type { TraceStore } from "./trace-store.js";
import type { TraceService } from "./trace-service.js";

const idParams = z.object({ id: z.string().uuid() });
const revertBody = z.object({ intentId: z.string().min(1) });
const traceParams = z.object({ id: z.string().min(8).max(64) });

export interface GlassboxDeps {
  traceStore: TraceStore;
  auditStore: AuditStore;
  traceService: TraceService;
  intentService?: IntentService;
  contextService?: ContextService;
  collectorToken: string;
}

export function registerGlassboxRoutes(
  app: FastifyInstance,
  deps: GlassboxDeps,
) {
  const tokenMatches = (candidate: string) => {
    const expected = Buffer.from(deps.collectorToken);
    const received = Buffer.from(candidate);
    return (
      expected.length > 0 &&
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    );
  };

  app.post(
    "/collector/v1/logs",
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      const token = request.headers["x-collector-token"];
      if (typeof token !== "string" || !tokenMatches(token)) {
        return reply.code(401).send({ error: "Invalid collector token" });
      }
      const result = deps.traceService.ingestLogs(request.body);
      if (result === null) {
        return reply.code(400).send({ error: "Not an OTLP logs payload" });
      }
      request.log.debug(result, "otlp logs ingested");
      return reply.code(200).send({ partialSuccess: {} });
    },
  );

  app.get("/api/agents/:id/traces", async (request) => {
    const { id } = idParams.parse(request.params);
    const warningCounts = deps.auditStore.warningCountByTrace();
    const health = deps.auditStore.healthByTrace();
    const traces = deps.traceStore.listByAgent(id).map((trace) => {
      let errorCount = 0;
      for (const span of trace.spans) {
        if (span.status === "error") errorCount += 1;
      }
      return {
        id: trace.id,
        agentId: trace.agentId,
        status: trace.status,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        prompt: trace.prompt,
        model: trace.model,
        usage: trace.usage,
        spanCount: trace.spans.length,
        errorCount,
        failingSpanId: trace.failingSpanId,
        // Why it failed, not merely that it did.
        failure: trace.failure,
        // A run that succeeded on the fifth attempt is not a clean run.
        recoveredErrorCount: trace.recoveredErrorCount,
        evidenceComplete: trace.evidenceComplete,
        warningCount: warningCounts.get(trace.id) ?? 0,
        // Reported apart from warningCount: an auditor outage is not an agent
        // defect, and counting the two together made every outage look like one.
        auditHealth: health.get(trace.id) ?? "ok",
      };
    });
    return { traces };
  });

  // One failure is an incident; the same failure five times is the thing to
  // fix. Grouped over data the trace store already holds.
  app.get("/api/agents/:id/failures", async (request) => {
    const { id } = idParams.parse(request.params);
    const groups = new Map<
      string,
      {
        kind: string;
        layer: string;
        retryability: string;
        title: string;
        remedy: string;
        count: number;
        lastSeenAt: string;
        traceIds: string[];
      }
    >();
    for (const trace of deps.traceStore.listByAgent(id)) {
      const failure = trace.failure;
      if (!failure) continue;
      const existing = groups.get(failure.kind);
      if (existing) {
        existing.count += 1;
        existing.traceIds.push(trace.id);
        continue;
      }
      groups.set(failure.kind, {
        kind: failure.kind,
        layer: failure.layer,
        retryability: failure.retryability,
        title: failure.title,
        remedy: failure.remedy,
        count: 1,
        // listByAgent is newest-first, so the first sighting is the latest.
        lastSeenAt: trace.endedAt ?? trace.startedAt,
        traceIds: [trace.id],
      });
    }
    // The Agent's own failures first: they are the ones changing the Agent can
    // fix. A platform outage sorted above them would bury the actionable half.
    const ranked = [...groups.values()].sort((left, right) => {
      const leftBlame = blamesAgent(left) ? 1 : 0;
      const rightBlame = blamesAgent(right) ? 1 : 0;
      if (leftBlame !== rightBlame) return rightBlame - leftBlame;
      return right.count - left.count;
    });
    return { failures: ranked };
  });

  app.get("/api/agents/:id/intent", async (request) => {
    const { id } = idParams.parse(request.params);
    if (!deps.intentService) {
      return {
        intent: { objective: "", extended: [] },
        versions: [],
        intentId: null,
      };
    }
    return deps.intentService.view(id);
  });

  // Restoring an earlier spec appends a new version rather than rewinding, so
  // an audit that pinned the reverted version can still be read back.
  app.post("/api/agents/:id/intent/revert", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { intentId } = revertBody.parse(request.body);
    if (!deps.intentService) {
      throw new HttpError(503, "Intent tracking is not enabled");
    }
    const result = deps.intentService.revert(id, intentId);
    if (!result.created) {
      throw new HttpError(
        409,
        "That intent version cannot be restored; it is unknown or already current",
      );
    }
    // The appended version is by definition the newest, so view.intentId is
    // already the id that was just created.
    return reply.code(201).send(result.view);
  });

  app.get("/api/traces/:id", async (request) => {
    const { id } = traceParams.parse(request.params);
    const payload = glassboxTrace(id);
    if (!payload) {
      throw new HttpError(404, "Trace not found");
    }
    return payload;
  });

  const downloadTrace = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = traceParams.parse(request.params);
    const payload = glassboxTrace(id);
    if (!payload) {
      throw new HttpError(404, "Trace not found");
    }
    reply.header(
      "content-disposition",
      'attachment; filename="trace-' + id + '.json"',
    );
    return {
      exportedAt: new Date().toISOString(),
      ...payload,
    };
  };

  app.get("/api/traces/:id/download", downloadTrace);

  app.get("/api/audits/:id", async (request) => {
    const { id } = traceParams.parse(request.params);
    const payload = auditorTrace(id);
    if (!payload) {
      throw new HttpError(404, "Audit not found");
    }
    return payload;
  });

  function glassboxTrace(id: string) {
    const trace = deps.traceStore.get(id);
    if (!trace) return null;
    const intentId = deps.auditStore.intentId(id);
    return {
      trace,
      findings: deps.auditStore.listByTrace(id),
      auditComplete: deps.auditStore.isRunComplete(id),
      auditHealth: deps.auditStore.health(id),
      intentId,
      intent: deps.intentService?.forTrace(trace.agentId, intentId) ?? null,
      context: deps.contextService?.view(id) ?? null,
    };
  }

  function auditorTrace(id: string) {
    const trace = deps.traceStore.get(id);
    if (!trace) return null;
    return {
      traceId: id,
      agentId: trace.agentId,
      health: deps.auditStore.health(id),
      spans: deps.auditStore.listAuditorSpans(id),
    };
  }
}
