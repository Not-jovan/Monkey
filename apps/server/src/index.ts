import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { createArkClient } from "./audits/ark-client.js";
import { AuditService } from "./audits/audit-service.js";
import { AuditStore } from "./audits/audit-store.js";
import { isArkConfigured, loadConfig, secretValues } from "./config.js";
import { IntentService } from "./intent/intent-service.js";
import { IntentStore } from "./intent/intent-store.js";
import { createRunner } from "./runner-factory.js";
import { selectRuntime } from "./runtimes/index.js";
import { JsonStore } from "./store.js";
import { createRedactor } from "./traces/redaction.js";
import { TraceService } from "./traces/trace-service.js";
import { TraceStore } from "./traces/trace-store.js";
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

const redactor = createRedactor(secretValues(config));
const traceStore = new TraceStore(path.join(config.dataDirectory, "traces"));
await traceStore.initialize();
const auditStore = new AuditStore(path.join(config.dataDirectory, "audits"));
await auditStore.initialize();
const intentStore = new IntentStore(path.join(config.dataDirectory, "intent"));
await intentStore.initialize();

const arkClient = createArkClient(config);
const auditingAvailable = config.auditEnabled && isArkConfigured(config);
const traceService = new TraceService(traceStore, redactor, runtime.trace);
const intentService = new IntentService({
  store: intentStore,
  client: arkClient,
  model: config.auditIntentModel,
  enabled: auditingAvailable,
  log: (message, error) => console.error(message, error),
});
const auditService = new AuditService({
  traceStore,
  auditStore,
  client: arkClient,
  securityModel: config.auditSecurityModel,
  intentModel: config.auditIntentModel,
  networkWhitelist: config.auditNetworkWhitelist,
  intent: intentService,
  enabled: auditingAvailable,
  log: (message, error) => console.error(message, error),
});
auditService.start();

const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  traceService,
);
await service.initialize();

const app = await createApp(config, service, {
  traceStore,
  auditStore,
  traceService,
  intentService,
  collectorToken,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await traceStore.flush();
  await auditStore.flush();
  await intentStore.flush();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
