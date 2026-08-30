import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentService } from "../../agent-service.js";
import { isAuditorTrace } from "../trace/trace-model.js";
import type { MiddlewareDeps } from "../types.js";
import { hasDivergedObjective, type IntentVersionEntry } from "./intent-model.js";

const idParams = z.object({ id: z.string().uuid() });

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
}
