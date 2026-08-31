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

  // Audits any trace, whatever produced it: an Agent's run, or the run of the
  // auditor that judged it, or the run of the auditor that judged *that*.
  //
  // On demand only, at every depth. Nothing subscribes to this — the automatic
  // audit fires for depth 0 alone — so a stack of auditors goes exactly as deep
  // as someone has asked for and no further.
  app.post("/api/traces/:id/audit", async (request, reply) => {
    const { id } = traceParams.parse(request.params);
    if (!deps.auditService) {
      throw new HttpError(503, "Auditing is not enabled");
    }
    const result = await deps.auditService.audit(id);
    if (result === null) {
      throw new HttpError(404, "Trace not found");
    }
    if (result === "in-flight") {
      throw new HttpError(409, "An audit is already running for this trace");
    }
    return reply.send(result);
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
    const auditTraceId = deps.traceStore.auditorTraceFor(id);
    const auditor =
      auditTraceId !== null ? (deps.traceStore.get(auditTraceId) ?? null) : null;
    archive.append(
      JSON.stringify(
        {
          auditedTraceId: id,
          agentId: trace.agentId,
          findings: deps.auditStore.listByTrace(id),
          auditTraceId,
          auditAttempts: deps.traceStore.auditorAttemptsFor(id),
          auditor,
          legacyAuditorSpans: auditor
            ? []
            : deps.auditStore.listAuditorSpans(id),
          health: deps.auditStore.health(id),
          legacyMetaAudit: deps.auditStore.metaAudit(id),
        },
        null,
        1,
      ) + "\n",
      { name: "audit.json" },
    );
    await archive.finalize();
    return reply;
  });

  // What the auditor did while judging this trace: its own trace, or — for a
  // run audited before auditors had traces — the spans that used to be stashed
  // on this document. Never presented as belonging to the run.
  function auditorTrace(id: string) {
    const trace = deps.traceStore.get(id);
    if (!trace) return null;
    const legacy = deps.auditStore.metaAudit(id);
    const auditTraceId = deps.traceStore.auditorTraceFor(id);
    const auditor =
      auditTraceId !== null ? (deps.traceStore.get(auditTraceId) ?? null) : null;
    return {
      // The run that was judged. The auditor's work is `auditor`, whose id is
      // `auditTraceId` — not this one.
      auditedTraceId: id,
      agentId: trace.agentId,
      health: deps.auditStore.health(id),
      auditTraceId,
      auditor,
      // Every auditor pass over this run, newest first. The `auditor` field
      // is still the latest; earlier attempts are how a mid-run failure stays
      // readable after a retry.
      auditAttempts: deps.traceStore.auditorAttemptsFor(id),
      // Pre-trace auditors stored their model calls on the run's audit
      // document. Kept only when there is no auditor trace to read instead.
      legacyAuditorSpans: auditor ? [] : deps.auditStore.listAuditorSpans(id),
      // An audit of the auditor recorded before that run had a trace of its
      // own. Read-only: nothing writes here any more, but a finding already
      // recorded should not vanish because the shape around it changed.
      legacyMetaAudit: legacy.findings,
      legacyMetaAuditedAt: legacy.auditedAt,
    };
  }
}
