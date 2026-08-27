import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { createArkClient } from "./audits/ark-client.js";
import { AuditService } from "./audits/audit-service.js";
import { AuditStore } from "./audits/audit-store.js";
import {
  isArkConfigured,
  loadConfig,
  secretValues,
  writeCodexConfig,
} from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { createRedactor } from "./traces/redaction.js";
import { TraceService } from "./traces/trace-service.js";
import { TraceStore } from "./traces/trace-store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
// Rotates every boot; writeCodexConfig hands it to the Runtime as the OTLP
// header the collector route requires.
const collectorToken = randomUUID();
await writeCodexConfig(config, collectorToken);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);

const redactor = createRedactor(secretValues(config));
const traceStore = new TraceStore(path.join(config.dataDirectory, "traces"));
await traceStore.initialize();
const auditStore = new AuditStore(path.join(config.dataDirectory, "audits"));
await auditStore.initialize();
const traceService = new TraceService(traceStore, redactor);
const arkClient = createArkClient(config);
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  traceService,
  isArkConfigured(config)
    ? { client: arkClient, model: config.auditIntentModel }
    : undefined,
);
const auditService = new AuditService({
  traceStore,
  auditStore,
  client: arkClient,
  securityModel: config.auditSecurityModel,
  intentModel: config.auditIntentModel,
  enabled: config.auditEnabled && isArkConfigured(config),
  whitelist: config.auditNetworkWhitelist,
  getIntent: (agentId) => {
    try {
      return service.getIntent(agentId);
    } catch {
      return null;
    }
  },
  log: (message, error) => console.error(message, error),
});
auditService.start();
await service.initialize();

const app = await createApp(config, service, {
  traceStore,
  auditStore,
  traceService,
  collectorToken,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await traceStore.flush();
  await auditStore.flush();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
