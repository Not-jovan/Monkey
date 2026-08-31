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
  );

  return {
    traceStore,
    traceService,
    redactor,
    flush: () => traceStore.flush(),
  };
}

export type TraceMiddleware = Awaited<ReturnType<typeof createTraceMiddleware>>;

export { registerTraceRoutes } from "./routes.js";
export { createRedactor, type Redactor } from "./redaction.js";
export { TraceService } from "./trace-service.js";
export { TraceStore } from "./trace-store.js";
export * from "./trace-model.js";
