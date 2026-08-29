import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { createArkClient } from "./audits/ark-client.js";
import {
  auditSteps,
  instructionsDriftFinding,
} from "./audits/audit-model.js";
import { AuditMemory } from "./audits/audit-memory.js";
import { AuditService } from "./audits/audit-service.js";
import { AuditStore } from "./audits/audit-store.js";
import { isArkConfigured, loadConfig, secretValues } from "./config.js";
import { ContextService } from "./context/context-service.js";
import { ContextStore } from "./context/context-store.js";
import { IntentService } from "./intent/intent-service.js";
import { IntentStore } from "./intent/intent-store.js";
import { describeIntent } from "./intent/intent-model.js";
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
const onStoreError = (message: string, error?: unknown) =>
  console.error(message, error);
const traceStore = new TraceStore(
  path.join(config.dataDirectory, "traces"),
  onStoreError,
);
await traceStore.initialize();
const auditStore = new AuditStore(
  path.join(config.dataDirectory, "audits"),
  onStoreError,
);
await auditStore.initialize();
const intentStore = new IntentStore(
  path.join(config.dataDirectory, "intent"),
  onStoreError,
);
await intentStore.initialize();
const contextStore = new ContextStore(
  path.join(config.dataDirectory, "context"),
  onStoreError,
);
await contextStore.initialize();
// PLAN_AUDITOR's audit memory: agent-runs/{agentId}/{chatId}/ holding one
// markdown record per audited step plus the meta index the analyses read.
const auditMemory = new AuditMemory(
  path.join(config.dataDirectory, "agent-runs"),
  onStoreError,
);

const arkClient = createArkClient(config);
const auditingAvailable = config.auditEnabled && isArkConfigured(config);

// Two configurations silently weaken auditing without failing anything, so say
// so once at boot rather than leaving an operator to infer it from findings
// that never appear.
if (auditingAvailable && config.auditSecurityModel === config.auditIntentModel) {
  console.warn(
    'AUDIT_SECURITY_MODEL and AUDIT_INTENT_MODEL are both "' +
      config.auditSecurityModel +
      '". Every audit fallback is guarded on the two differing, so there is no ' +
      "degraded path: one model failure loses the step's judged verdict outright.",
  );
}
if (auditingAvailable && config.auditNetworkWhitelist === null) {
  console.warn(
    "AUDIT_NETWORK_WHITELIST is unset, so the network policy check is disabled " +
      "and no destination will ever be reported. Set it to a comma-separated " +
      "host list, or to an empty value to deny every destination.",
  );
}

const traceService = new TraceService(traceStore, redactor, runtime.trace);
const intentService = new IntentService({
  store: intentStore,
  client: arkClient,
  model: config.auditIntentModel,
  enabled: auditingAvailable,
  // A classification that never produced a verdict is a middleware failure, not
  // an agent defect, so it is filed under audit-health beside a model outage.
  onClassifyFailed: ({ agentId, traceId, attempts, failure }) => {
    if (!traceId) return;
    const trace = traceStore.get(traceId);
    if (!trace) return;
    auditStore.recordRunFinding(
      trace,
      auditSteps(
        { id: randomUUID(), traceId, agentId, spanId: null },
        (push) =>
          push(
            "error",
            "audit-health",
            "This message was not classified after " +
              attempts +
              " attempts, so any specification change it carried was never " +
              "applied and later steps were audited against the previous spec: " +
              failure,
          ),
      ),
      intentStore.latest(agentId)?.intentId ?? "",
      "failed",
    );
  },
  log: (message, error) => console.error(message, error),
});
// Started before the auditor so a run's own context record exists by the time
// the run-level audit looks for what came before it.
const contextService = new ContextService({
  traceStore,
  store: contextStore,
});
contextService.start();

const auditService = new AuditService({
  traceStore,
  auditStore,
  context: contextStore,
  client: arkClient,
  securityModel: config.auditSecurityModel,
  intentModel: config.auditIntentModel,
  networkWhitelist: config.auditNetworkWhitelist,
  intent: intentService,
  memory: auditMemory,
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
  // The standing spec, handed to the runtime so the agent works under it.
  (agentId) => {
    const intent = intentService.state(agentId);
    return intent.objective.length > 0 || intent.extended.length > 0
      ? describeIntent(intent)
      : "";
  },
  // AGENTS.md is the spec the agent actually reads, it lives inside the
  // workspace, and the default sandbox is workspace-write — so the agent can
  // edit what governs it. Nothing else writes the file between runs, so a
  // difference means the platform is no longer the only author of the spec.
  ({ agentId, traceId, when }) => {
    const trace = traceStore.get(traceId);
    if (!trace) return;
    const intentId = intentStore.latest(agentId)?.intentId ?? "";
    auditStore.recordRunFinding(
      trace,
      instructionsDriftFinding(
        { id: randomUUID(), traceId, agentId, intentId },
        when,
      ),
      intentId,
      "degraded",
    );
  },
);
await service.initialize();

const app = await createApp(config, service, {
  traceStore,
  auditStore,
  traceService,
  intentService,
  contextService,
  // Reached only by the manual meta-audit route; nothing subscribes to it.
  auditService,
  auditMemory,
  collectorToken,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await traceStore.flush();
  await auditStore.flush();
  await intentStore.flush();
  await contextStore.flush();
  await auditMemory.flush();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
