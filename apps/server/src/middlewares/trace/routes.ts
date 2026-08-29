import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { blamesAgent } from "../../failures.js";
import { isAuditorTrace } from "./trace-model.js";
import { HttpError } from "../../errors.js";
import type { MiddlewareDeps } from "../types.js";

const idParams = z.object({ id: z.string().uuid() });
const traceParams = z.object({ id: z.string().min(8).max(64) });

export function registerTraceRoutes(
  app: FastifyInstance,
  deps: MiddlewareDeps,
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
    const auditCounts = deps.auditStore.countsByTrace();
    const health = deps.auditStore.healthByTrace();
    // Auditor runs share the agent's id, because that is who they are about.
    // They are not runs of the Agent though, so they are not in its run list —
    // you reach one by opening the run it judged.
    const traces = deps.traceStore
      .listByAgent(id)
      .filter((trace) => !isAuditorTrace(trace))
      .map((trace) => {
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
          warningCount: auditCounts.get(trace.id)?.warnings ?? 0,
          // Apart from warningCount for the same reason auditHealth is: the
          // auditor saying "I could not settle this" is not the auditor saying
          // the agent did something wrong.
          suspicionCount: auditCounts.get(trace.id)?.suspicions ?? 0,
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
      // The auditor that judged this trace, if it has been judged.
      auditTraceId: deps.traceStore.auditorTraceFor(id),
      // Everything this trace is an audit of, up to the Agent run at the root,
      // oldest first. Resolved here rather than by the client walking auditOf
      // one request at a time — the chain has no ceiling, and the breadcrumb
      // needs all of it at once.
      auditChain: deps.traceStore.auditChain(id).map((entry) => ({
        id: entry.id,
        auditDepth: entry.auditDepth,
      })),
    };
  }
}
