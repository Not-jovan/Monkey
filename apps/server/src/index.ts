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
await runtime.bootstrap(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config, runtime);

const onStoreError = (message: string, error?: unknown) =>
  console.error(message, error);
const log = (message: string, error?: unknown) => console.error(message, error);

const arkClient = createArkClient(config, config.auditModelTimeoutMs);
const auditingAvailable = config.auditEnabled && isArkConfigured(config);

// Built in dependency order: context reads the trace store, and the auditor
// reads both. Intent is derived on the auditor, not as its own store.
const trace = await createTraceMiddleware({ config, runtime, onStoreError });
const context = await createContextMiddleware({
  config,
  traceStore: trace.traceStore,
  onStoreError,
});
const audit = await createAuditMiddleware({
  config,
  client: arkClient,
  enabled: auditingAvailable,
  traceStore: trace.traceStore,
  traceService: trace.traceService,
  contextStore: context.contextStore,
  onStoreError,
  log,
  warn: (message) => console.warn(message),
});
// No dependency on the others: an operator's corrections are a record of what
// they changed, not an input to auditing.
const intent = await createIntentMiddleware({ config, onStoreError });

const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  trace.traceService,
  audit.describeFor,
  audit.onInstructionsDrift,
);
await service.initialize();

const app = await createApp(config, service, {
  traceStore: trace.traceStore,
  traceService: trace.traceService,
  auditStore: audit.auditStore,
  auditService: audit.auditService,
  auditMemory: audit.auditMemory,
  contextService: context.contextService,
  correctionStore: intent.correctionStore,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  trace.stopScraping();
  await trace.flush();
  await context.flush();
  await audit.flush();
  await intent.flush();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
