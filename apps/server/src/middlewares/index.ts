import type { FastifyInstance } from "fastify";
import type { AgentService } from "../agent-service.js";
import { registerAuditRoutes } from "./audit/index.js";
import { registerIntentRoutes } from "./intent/index.js";
import { registerTraceRoutes } from "./trace/index.js";
import type { MiddlewareDeps } from "./types.js";

export function registerMiddlewareRoutes(
  app: FastifyInstance,
  deps: MiddlewareDeps,
  service: AgentService,
) {
  registerTraceRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerIntentRoutes(app, deps, service);
}

export type { MiddlewareDeps } from "./types.js";
export * from "./audit/index.js";
export * from "./context/index.js";
export * from "./intent/index.js";
export * from "./run-transcript/index.js";
export * from "./trace/index.js";
