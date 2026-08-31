import { stat } from "node:fs/promises";
import path from "node:path";
import { secretValues, type AppConfig } from "../../config.js";
import type { RuntimeDefinition } from "../../runtimes/types.js";
import { createRedactor } from "./redaction.js";
import {
  replayPersistedRuntimeEvents,
  runtimeEventFilePath,
} from "../../runtime-event-scraper.js";
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

  for (const trace of traceStore.list()) {
    if (trace.evidenceComplete) continue;
    if (trace.status === "running" || trace.endedAt === null) continue;
    const filePath = runtimeEventFilePath(input.config.dataDirectory, trace.id);
    const fileInfo = await stat(filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!fileInfo) continue;
    const outcome = traceService.prepareRuntimeEventRecovery(trace.id);
    if (!outcome) continue;
    const replayed = await replayPersistedRuntimeEvents({
      dataDirectory: input.config.dataDirectory,
      runId: trace.id,
      onEvent: (event) => traceService.onRunnerEvent(trace.id, event),
      onProblem: (problem) => traceService.onEventStreamProblem(trace.id, problem),
      isTerminalEvent: input.runtime.isTerminalEvent,
    });
    if (!replayed) continue;
    traceService.onRunEnd(trace.id, {
      status: outcome.status,
      endedAt: outcome.endedAt ?? undefined,
      error: outcome.error,
      model: outcome.model,
      failure: outcome.failure,
    });
  }

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
