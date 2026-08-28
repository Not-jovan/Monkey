import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditStore } from "../audits/audit-store.js";
import type { IntentService } from "../intent/intent-service.js";
import { HttpError } from "../errors.js";
import type { TraceStore } from "./trace-store.js";
import type { TraceService } from "./trace-service.js";

const idParams = z.object({ id: z.string().uuid() });
const traceParams = z.object({ id: z.string().min(8).max(64) });

export interface GlassboxDeps {
  traceStore: TraceStore;
  auditStore: AuditStore;
  traceService: TraceService;
  intentService?: IntentService;
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
        warningCount: warningCounts.get(trace.id) ?? 0,
      };
    });
    return { traces };
  });

  app.get("/api/agents/:id/intent", async (request) => {
    const { id } = idParams.parse(request.params);
    if (!deps.intentService) {
      return {
        intent: { objective: "", extended: [] },
        versions: {},
        intentId: null,
      };
    }
    return deps.intentService.view(id);
  });

  app.get("/api/traces/:id", async (request) => {
    const { id } = traceParams.parse(request.params);
    const trace = deps.traceStore.get(id);
    if (!trace) {
      throw new HttpError(404, "Trace not found");
    }
    const findings = deps.auditStore.listByTrace(id);
    return {
      trace,
      findings,
      auditComplete: deps.auditStore.isRunComplete(id),
      intentId: deps.auditStore.intentId(id),
    };
  });

  const downloadTrace = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = traceParams.parse(request.params);
    const trace = deps.traceStore.get(id);
    if (!trace) {
      throw new HttpError(404, "Trace not found");
    }
    reply.header(
      "content-disposition",
      'attachment; filename="trace-' + id + '.json"',
    );
    const findings = deps.auditStore.listByTrace(id);
    return {
      exportedAt: new Date().toISOString(),
      trace,
      findings,
      auditComplete: deps.auditStore.isRunComplete(id),
      intentId: deps.auditStore.intentId(id),
    };
  };

  app.get("/api/traces/:id/download", downloadTrace);
}
