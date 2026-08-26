import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuditStore } from "../audits/audit-store.js";
import { HttpError } from "../errors.js";
import type { TraceStore } from "./trace-store.js";
import type { TraceService } from "./trace-service.js";

const idParams = z.object({ id: z.string().uuid() });
const traceParams = z.object({ id: z.string().min(8).max(64) });

export interface GlassboxDeps {
  traceStore: TraceStore;
  auditStore: AuditStore;
  traceService: TraceService;
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

  // OTLP/HTTP JSON ingest. Lives outside /api on purpose: the Runtime cannot
  // hold the operator's bearer token, so it authenticates with a per-boot
  // collector token that writeCodexConfig embeds in config.toml. Batches with
  // full tool output routinely exceed the default 1 MB body limit.
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
    const traces = deps.traceStore.listByAgent(id).map((summary) => ({
      ...summary,
      warningCount: warningCounts.get(summary.id) ?? 0,
    }));
    return { traces, lifecycle: deps.traceStore.lifecycleFor(id) };
  });

  app.get("/api/traces/:id", async (request) => {
    const { id } = traceParams.parse(request.params);
    const trace = deps.traceStore.get(id);
    if (!trace) {
      throw new HttpError(404, "Trace not found");
    }
    return { trace, audits: deps.auditStore.listByTrace(id) };
  });

  app.get("/api/traces/:id/export", async (request, reply) => {
    const { id } = traceParams.parse(request.params);
    const trace = deps.traceStore.get(id);
    if (!trace) {
      throw new HttpError(404, "Trace not found");
    }
    reply.header(
      "content-disposition",
      'attachment; filename="trace-' + id + '.json"',
    );
    return {
      exportedAt: new Date().toISOString(),
      trace,
      audits: deps.auditStore.listByTrace(id),
    };
  });
}
