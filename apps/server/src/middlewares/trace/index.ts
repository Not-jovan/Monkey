import path from "node:path";
import { secretValues, type AppConfig } from "../../config.js";
import type { RuntimeDefinition } from "../../runtimes/types.js";
import { createRedactor } from "./redaction.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

export async function createTraceMiddleware(input: {
  config: AppConfig;
  runtime: RuntimeDefinition;
  onStoreError: (message: string, error?: unknown) => void;
}) {
  const redactor = createRedactor(secretValues(input.config));
  const traceStore = new TraceStore(
    path.join(input.config.dataDirectory, "traces"),
    input.onStoreError,
  );
  await traceStore.initialize();
  const traceService = new TraceService(
    traceStore,
    redactor,
    input.runtime.trace,
    input.runtime.homeDir(input.config),
  );
  // Catches up anything the runtime's own session log recorded but this
  // process never scraped into spans before the last shutdown/crash, then
  // starts polling for what arrives from here on. Order matters: after
  // traceStore.initialize() has already flipped orphaned "running" traces to
  // "failed".
  await traceService.reconcileFromDisk();
  const stopScraping = traceService.startScraping();

  return {
    traceStore,
    traceService,
    redactor,
    flush: () => traceStore.flush(),
    stopScraping,
  };
}

export type TraceMiddleware = Awaited<ReturnType<typeof createTraceMiddleware>>;

export { registerTraceRoutes } from "./routes.js";
export { createRedactor, type Redactor } from "./redaction.js";
export { TraceService } from "./trace-service.js";
export { TraceStore } from "./trace-store.js";
export * from "./trace-model.js";
