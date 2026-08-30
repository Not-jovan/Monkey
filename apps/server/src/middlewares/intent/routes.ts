import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../../agent-service.js";
import { HttpError } from "../../errors.js";
import { isAuditorTrace } from "../trace/trace-model.js";
import type { MiddlewareDeps } from "../types.js";
import { hasDivergedObjective, type IntentVersionEntry } from "./intent-model.js";

const idParams = z.object({ id: z.string().uuid() });
const traceParams = z.object({ id: z.string().min(8).max(64) });

const correctionBody = z.object({
  // Plural from the outset. One correction usually answers several findings
  // that are really one problem, and asking the operator to file them one at a
  // time produces a spec that reads as a list of near-duplicates.
  findingIds: z.array(z.string().min(1)).min(1),
  correction: z.string().min(1).max(2_000),
});

const revertBody = z.object({ correctionId: z.string().min(1) });

export function registerIntentRoutes(
  app: FastifyInstance,
  deps: MiddlewareDeps,
  service: AgentService,
) {
  app.get("/api/agents/:id/intent", async (request) => {
    const { id } = idParams.parse(request.params);
    const agent = service.getAgent(id);
    const versions: IntentVersionEntry[] = [];
    const traces = [...deps.traceStore.listByAgent(id)].reverse();
    for (const trace of traces) {
      if (isAuditorTrace(trace)) continue;
      const state = deps.auditStore.intentOf(trace.id);
      if (!state) continue;
      const derivation = deps.auditStore.derivationOf(trace.id);
      versions.push({
        id: trace.id,
        instructions: state.instructions,
        objective: state.objective,
        extended: state.extended,
        createdAt: trace.startedAt,
        update: derivation
          ? {
              logs: derivation.reason ? [derivation.reason] : [],
              kind: derivation.kind,
              message: derivation.message ?? undefined,
              reason: derivation.reason,
              addedConstraints: derivation.addedConstraints,
              removedConstraints: derivation.removedConstraints,
              previousObjective: derivation.previousObjective,
              traceId: trace.id,
              revertedFrom: null,
            }
          : undefined,
      });
    }
    const latest = versions.at(-1);
    const intent = latest
      ? {
          instructions: latest.instructions,
          objective: latest.objective,
          extended: [...latest.extended],
        }
      : {
          instructions: agent.instructions,
          objective: agent.instructions,
          extended: [],
        };
    return {
      intent,
      diverged: hasDivergedObjective(intent),
      versions,
      intentId: latest?.id ?? null,
    };
  });

  app.get("/api/agents/:id/corrections", async (request) => {
    const { id } = idParams.parse(request.params);
    service.getAgent(id);
    return { corrections: deps.correctionStore?.list(id) ?? [] };
  });

  // A finding is evidence, not authority to rewrite the Agent. Only this
  // explicit operator action turns one into a constraint — and it does so by
  // editing the instructions, because those are the spec: the auditor's
  // reducer rebases onto them on the next run, so nothing else has to be told.
  app.post("/api/traces/:id/intent/correct", async (request, reply) => {
    const { id } = traceParams.parse(request.params);
    const body = correctionBody.parse(request.body);
    const store = deps.correctionStore;
    if (!store) {
      throw new HttpError(503, "Intent correction is not enabled");
    }

    const trace = deps.traceStore.get(id);
    if (!trace) throw new HttpError(404, "Trace not found");
    if (isAuditorTrace(trace)) {
      throw new HttpError(
        409,
        "Correct the audited Agent run, not the auditor's own trace",
      );
    }
    const agent = service.getAgent(trace.agentId);
    if (trace.status === "running") {
      throw new HttpError(409, "Wait for the run to finish before correcting it");
    }
    if (!deps.auditStore.isRunComplete(id)) {
      throw new HttpError(
        409,
        "Wait for the audit to finish before correcting this run",
      );
    }
    // A correction read off one run must not land while another is being
    // judged against the spec it is about to change.
    const active = deps.traceStore
      .listByAgent(trace.agentId)
      .find((entry) => entry.status === "running");
    if (active) {
      throw new HttpError(
        409,
        "Wait for the Agent's active run to finish before changing its intent",
      );
    }

    // Every finding has to be evidence from this very run. Without this a
    // correction could cite a finding belonging to another trace, and the
    // provenance record would point somewhere the operator never looked.
    const findings = deps.auditStore.listByTrace(id);
    for (const findingId of body.findingIds) {
      const finding = findings.find((entry) => entry.id === findingId);
      if (
        !finding ||
        finding.traceId !== trace.id ||
        finding.agentId !== trace.agentId ||
        (finding.spanId !== null &&
          !trace.spans.some((span) => span.id === finding.spanId))
      ) {
        throw new HttpError(404, "Finding " + findingId + " is not on this run");
      }
    }
    const alreadyCorrected = new Set(
      store
        .list(agent.id)
        .filter((entry) => entry.traceId === trace.id && entry.revertedAt === null)
        .flatMap((entry) => entry.findingIds),
    );
    const duplicate = body.findingIds.find((findingId) =>
      alreadyCorrected.has(findingId),
    );
    if (duplicate) {
      throw new HttpError(409, "Finding " + duplicate + " has already been corrected");
    }

    const { agent: corrected, instructionsBefore } =
      await service.appendInstruction(agent.id, body.correction);

    // The spec moves first, the record of why second — and a correction with
    // no record is the worse of the two failures: the Agent carries a rule
    // nobody can see or undo. So if the record cannot be written, put the
    // spec back.
    let correction;
    try {
      correction = await store.append({
        id: randomUUID(),
        agentId: agent.id,
        traceId: trace.id,
        findingIds: [...body.findingIds],
        correction: body.correction.trim(),
        instructionsBefore,
        createdAt: new Date().toISOString(),
        revertedAt: null,
      });
    } catch (error) {
      // Only undo this edit, never a snapshot. If anything else moved the
      // spec in between, restoring what it said beforehand would throw that
      // away too — the same reason undo is offered for the newest correction
      // alone. Leaving it is the safer half of a choice with no clean answer,
      // and the failure is reported either way.
      if (service.getAgent(agent.id).instructions === corrected.instructions) {
        await service.updateAgent(agent.id, { instructions: instructionsBefore });
      }
      throw error;
    }
    return reply.code(201).send({ correction });
  });

  // Undo, not "revert to a version". `instructionsBefore` describes the spec
  // immediately before one edit, so only the newest correction still in force
  // can be undone — restoring an older one would silently discard every
  // correction made after it.
  app.post("/api/agents/:id/intent/revert", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { correctionId } = revertBody.parse(request.body);
    const store = deps.correctionStore;
    if (!store) {
      throw new HttpError(503, "Intent correction is not enabled");
    }
    service.getAgent(id);

    const target = store.get(id, correctionId);
    if (!target) throw new HttpError(404, "Correction not found");
    if (target.revertedAt !== null) {
      throw new HttpError(409, "That correction has already been undone");
    }
    const newest = store.latestActive(id);
    if (!newest || newest.id !== target.id) {
      throw new HttpError(
        409,
        "Only the most recent correction can be undone; undo the ones after it first",
      );
    }

    const agent = await service.updateAgent(id, {
      instructions: target.instructionsBefore,
    });
    const correction = await store.markReverted(
      id,
      target.id,
      new Date().toISOString(),
    );
    return reply.code(201).send({ correction, instructions: agent.instructions });
  });
}
