import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toAuditTraceSteps } from "../audits/audit-model.js";
import type { AuditStore } from "../audits/audit-store.js";
import type { IntentService } from "../intent/intent-service.js";
import { HttpError } from "../errors.js";
import type { TraceStore } from "./trace-store.js";
import type { TraceService } from "./trace-service.js";

const idParams = z.object({ id: z.string().uuid() });
const traceParams = z.object({ id: z.string().min(8).max(64) });
const intentUpdateParams = z.object({
  id: z.string().uuid(),
  updateId: z.string().uuid(),
});
const intentDecisionBody = z.object({
  decision: z.enum(["confirm", "reject"]),
});

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

  app.get("/api/agents/:id/intent", async (request) => {
    const { id } = idParams.parse(request.params);
    const record = deps.intentService?.record(id) ?? null;
    return {
      intent: record
        ? { objective: record.objective, extended: record.extended }
        : { objective: "", extended: [] },
      pending: deps.intentService?.pending(id) ?? [],
      history: record?.history ?? [],
      requiresConfirmation:
        deps.intentService?.requiresConfirmation() ?? false,
      updatedAt: record?.updatedAt ?? null,
    };
  });

  // The user's decision on a proposed change to the specification. Nothing
  // takes effect until this lands.
  app.post("/api/agents/:id/intent/:updateId", async (request) => {
    const { id, updateId } = intentUpdateParams.parse(request.params);
    const { decision } = intentDecisionBody.parse(request.body);
    if (!deps.intentService) {
      throw new HttpError(503, "Intent tracking is not enabled");
    }
    const record = deps.intentService.resolve(id, updateId, decision);
    if (!record) {
      throw new HttpError(404, "No pending intent update with that id");
    }
    return {
      intent: { objective: record.objective, extended: record.extended },
      pending: deps.intentService.pending(id),
    };
  });

  app.get("/api/traces/:id", async (request) => {
    const { id } = traceParams.parse(request.params);
    const trace = deps.traceStore.get(id);
    if (!trace) {
      throw new HttpError(404, "Trace not found");
    }
    const audits = deps.auditStore.listByTrace(id);
    // AUDIT_PLAN's flat output shape, derived rather than stored: one audit can
    // carry several findings.
    return { trace, audits, findings: audits.flatMap(toAuditTraceSteps) };
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
    const audits = deps.auditStore.listByTrace(id);
    return {
      exportedAt: new Date().toISOString(),
      trace,
      audits,
      findings: audits.flatMap(toAuditTraceSteps),
    };
  };

  app.get("/api/traces/:id/download", downloadTrace);
  app.get("/api/traces/:id/export", downloadTrace);
}
