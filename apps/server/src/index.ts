import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { createArkClient } from "./ark-client.js";
import { isArkConfigured, loadConfig } from "./config.js";
import {
  createAuditMiddleware,
  createContextMiddleware,
  createIntentMiddleware,
  createTraceMiddleware,
} from "./middlewares/index.js";
import { createRunner } from "./runner-factory.js";
import { selectRuntime } from "./runtimes/index.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
const runtime = selectRuntime(config);
// Rotates every boot; runtime.bootstrap hands it to the Runtime as the OTLP
// header the collector route requires.
const collectorToken = randomUUID();
await runtime.bootstrap(config, collectorToken);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config, runtime, collectorToken);

const onStoreError = (message: string, error?: unknown) =>
  console.error(message, error);
const log = (message: string, error?: unknown) => console.error(message, error);

const arkClient = createArkClient(config);
const auditingAvailable = config.auditEnabled && isArkConfigured(config);

// Built in dependency order: context and intent read the trace store, and the
// auditor reads all three.
const trace = await createTraceMiddleware({ config, runtime, onStoreError });
const context = await createContextMiddleware({
  config,
  traceStore: trace.traceStore,
  onStoreError,
});
const intent = await createIntentMiddleware({
  config,
  client: arkClient,
  enabled: auditingAvailable,
  onStoreError,
  log,
});
const audit = await createAuditMiddleware({
  config,
  client: arkClient,
  enabled: auditingAvailable,
  traceStore: trace.traceStore,
  traceService: trace.traceService,
  contextStore: context.contextStore,
  intent,
  onStoreError,
  log,
  warn: (message) => console.warn(message),
});

const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  trace.traceService,
  intent.describeFor,
  audit.onInstructionsDrift,
);
await service.initialize();

const app = await createApp(config, service, {
  traceStore: trace.traceStore,
  traceService: trace.traceService,
  auditStore: audit.auditStore,
  // Reached only by the manual meta-audit route; nothing subscribes to it.
  auditService: audit.auditService,
  auditMemory: audit.auditMemory,
  intentService: intent.intentService,
  contextService: context.contextService,
  collectorToken,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await trace.flush();
  await context.flush();
  await intent.flush();
  await audit.flush();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
