import path from "node:path";
import type { AppConfig } from "../../config.js";
import type { TraceStore } from "../trace/trace-store.js";
import { ContextService } from "./context-service.js";
import { ContextStore } from "./context-store.js";

export async function createContextMiddleware(input: {
  config: AppConfig;
  traceStore: TraceStore;
  onStoreError: (message: string, error?: unknown) => void;
}) {
  const contextStore = new ContextStore(
    path.join(input.config.dataDirectory, "context"),
    input.onStoreError,
  );
  await contextStore.initialize();
  const contextService = new ContextService({
    traceStore: input.traceStore,
    store: contextStore,
  });
  // Started here, and before the audit middleware is created, so a run's own
  // context record exists by the time the run-level audit looks for what came
  // before it.
  contextService.start();

  return {
    contextStore,
    contextService,
    flush: () => contextStore.flush(),
  };
}

export type ContextMiddleware = Awaited<
  ReturnType<typeof createContextMiddleware>
>;

export { ContextService, type ContextView } from "./context-service.js";
export { ContextStore } from "./context-store.js";
