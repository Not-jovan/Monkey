import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ZipArchive } from "archiver";
import { HttpError } from "../../errors.js";
import type { MiddlewareDeps } from "../types.js";

const traceParams = z.object({ id: z.string().min(8).max(64) });

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: MiddlewareDeps,
) {
  app.get("/api/audits/:id", async (request) => {
    const { id } = traceParams.parse(request.params);
    const payload = auditorTrace(id);
    if (!payload) {
      throw new HttpError(404, "Audit not found");
    }
    return payload;
  });

  // PLAN_AUDITOR: audit the auditor, on demand only. There is deliberately no
  // subscription that reaches this — the auditor's own steps would otherwise
  // become input for another meta-audit, without limit.
  app.post("/api/audits/:id/meta", async (request, reply) => {
    const { id } = traceParams.parse(request.params);
    if (!deps.auditService) {
      throw new HttpError(503, "Auditing is not enabled");
    }
    const result = await deps.auditService.auditAuditor(id);
    if (result === null) {
      throw new HttpError(404, "Audit not found");
    }
    if (result === "in-flight") {
      throw new HttpError(409, "A meta-audit is already running for this run");
    }
    return reply.send({ traceId: id, ...result });
  });

  // The plan's /audit/{chatId} download: every artifact the auditor wrote for
  // this chat, plus the audit document, as one zip.
  app.get("/api/audits/:id/archive", async (request, reply) => {
    const { id } = traceParams.parse(request.params);
    const trace = deps.traceStore.get(id);
    if (!trace) {
      throw new HttpError(404, "Audit not found");
    }
    const artifacts =
      (await deps.auditMemory?.listArtifacts(trace.agentId, id)) ?? [];

    reply.header("content-type", "application/zip");
    reply.header(
      "content-disposition",
      'attachment; filename="audit-' + id + '.zip"',
    );
    const archive = new ZipArchive({ zlib: { level: 9 } });
    // Streamed rather than buffered: a long run's memory folder is many files,
    // and the reply should start before the last one is read.
    reply.send(archive);
    for (const artifact of artifacts) {
      archive.file(artifact.filePath, { name: "memory/" + artifact.name });
    }
    // The audit document itself is not in the memory folder, and it is the part
    // that carries the findings the UI shows.
    archive.append(
      JSON.stringify(
        {
          traceId: id,
          agentId: trace.agentId,
          findings: deps.auditStore.listByTrace(id),
          auditorSpans: deps.auditStore.listAuditorSpans(id),
          metaAudit: deps.auditStore.metaAudit(id),
          health: deps.auditStore.health(id),
        },
        null,
        1,
      ) + "\n",
      { name: "audit.json" },
    );
    await archive.finalize();
    return reply;
  });

  function auditorTrace(id: string) {
    const trace = deps.traceStore.get(id);
    if (!trace) return null;
    const meta = deps.auditStore.metaAudit(id);
    return {
      traceId: id,
      agentId: trace.agentId,
      health: deps.auditStore.health(id),
      spans: deps.auditStore.listAuditorSpans(id),
      // Findings from auditing the auditor. Empty until someone asks for it:
      // this never runs on its own.
      metaAudit: meta.findings,
      metaAuditedAt: meta.auditedAt,
    };
  }
}
