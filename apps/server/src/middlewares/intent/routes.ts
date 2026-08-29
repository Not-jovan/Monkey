import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../../agent-service.js";
import { HttpError } from "../../errors.js";
import type { AgentExists, MiddlewareDeps } from "../types.js";

const idParams = z.object({ id: z.string().uuid() });
const traceParams = z.object({ id: z.string().min(8).max(64) });
const revertBody = z.object({ intentId: z.string().min(1) });
const correctionBody = z.object({
  findingId: z.string().min(1).max(200),
  correction: z.string().trim().min(1).max(1_000),
});

export function registerIntentRoutes(
  app: FastifyInstance,
  deps: MiddlewareDeps,
  service: AgentService,
  agentExists: AgentExists,
) {
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

  // A finding is evidence, not authority to rewrite the Agent. Only this
  // explicit operator action appends the correction to the active intent.
  app.post("/api/traces/:id/intent/correct", async (request, reply) => {
    const { id } = traceParams.parse(request.params);
    const body = correctionBody.parse(request.body);
    if (!deps.intentService) {
      throw new HttpError(503, "Intent tracking is not enabled");
    }
    const trace = deps.traceStore.get(id);
    if (!trace) throw new HttpError(404, "Trace not found");
    if (!agentExists(trace.agentId)) throw new HttpError(404, "Agent not found");
    if (trace.status === "running") {
      throw new HttpError(409, "Wait for the run to finish before correcting it");
    }
    if (!deps.auditStore.isRunComplete(id)) {
      throw new HttpError(
        409,
        "Wait for the audit to finish before correcting this run",
      );
    }
    const activeTrace = deps.traceStore
      .listByAgent(trace.agentId)
      .find((entry) => entry.status === "running");
    if (activeTrace) {
      throw new HttpError(
        409,
        "Wait for the Agent's active run to finish before changing its intent",
      );
    }
    const finding = deps.auditStore
      .listByTrace(id)
      .find((entry) => entry.id === body.findingId);
    if (
      !finding ||
      finding.traceId !== trace.id ||
      finding.agentId !== trace.agentId ||
      (finding.spanId !== null &&
        !trace.spans.some((span) => span.id === finding.spanId))
    ) {
      throw new HttpError(404, "Audit finding not found on this trace");
    }
    if (finding.category === "audit-health") {
      throw new HttpError(400, "Auditor health cannot change the Agent's intent");
    }
    const correction = deps.traceService.redactText(body.correction);
    if (
      !deps.intentService.canApplyHumanCorrection(
        trace.agentId,
        finding.id,
        correction,
      )
    ) {
      throw new HttpError(
        409,
        "This finding was already corrected or the constraint is already active",
      );
    }
    const result = deps.intentService.applyHumanCorrection(trace.agentId, {
      correction,
      traceId: trace.id,
      findingId: finding.id,
      spanId: finding.spanId,
    });
    if (!result.created) {
      throw new HttpError(
        409,
        "This finding was already corrected or the constraint is already active",
      );
    }
    return reply.code(201).send(result.view);
  });

  // Collapses a divergence back to one source of truth. The objective the
  // conversation arrived at is written into the agent's instructions, which
  // regenerates AGENTS.md, and the record then agrees with what the agent
  // reads. Deliberately explicit: a classification must never rewrite
  // user-authored configuration on its own.
  app.post("/api/agents/:id/intent/adopt", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!deps.intentService) {
      throw new HttpError(503, "Intent tracking is not enabled");
    }
    service.getAgent(id);
    const objective = deps.intentService.pendingAdoption(id);
    if (objective === null) {
      throw new HttpError(
        409,
        "This agent's objective already matches its instructions",
      );
    }
    // Goes through updateAgent so AGENTS.md is rewritten and the busy-agent
    // guard applies — adopting mid-run would change the spec underneath it.
    const agent = await service.updateAgent(id, { instructions: objective });
    deps.intentService.syncInstructions(id, agent.instructions, "adopted");
    return reply.send({ agent, intent: deps.intentService.view(id) });
  });
}
