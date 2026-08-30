import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ArkClient } from "../../ark-client.js";
import { ArkRunner } from "../../ark-runner.js";
import type { AppConfig } from "../../config.js";
import type { InstructionsDrift } from "../../agent-service.js";
import { describeIntent } from "../intent/intent-model.js";
import { isAuditorTrace } from "../trace/trace-model.js";
import type { ContextStore } from "../context/context-store.js";
import type { TraceService } from "../trace/trace-service.js";
import type { TraceStore } from "../trace/trace-store.js";
import { AuditMemory } from "./audit-memory.js";
import { auditSteps, instructionsDriftFinding } from "./audit-model.js";
import { AuditService } from "./audit-service.js";
import { AuditStore } from "./audit-store.js";
import { VERDICT_MAX_TOKENS } from "./auditor-model.js";

export async function createAuditMiddleware(input: {
  config: AppConfig;
  client: ArkClient;
  enabled: boolean;
  traceStore: TraceStore;
  // Records the auditor's own run as a trace, which is what makes that run
  // openable, and so auditable in turn.
  traceService: TraceService;
  contextStore: ContextStore;
  onStoreError: (message: string, error?: unknown) => void;
  log: (message: string, error?: unknown) => void;
  warn: (message: string) => void;
}) {
  const { config, traceStore } = input;

  const auditStore = new AuditStore(
    path.join(config.dataDirectory, "audits"),
    input.onStoreError,
  );
  await auditStore.initialize();
  const auditMemory = new AuditMemory(
    path.join(config.dataDirectory, "agent-runs"),
    input.onStoreError,
  );

  if (input.enabled && config.auditSecurityModel === config.auditIntentModel) {
    input.warn(
      'AUDIT_SECURITY_MODEL and AUDIT_INTENT_MODEL are both "' +
        config.auditSecurityModel +
        '". Every audit fallback is guarded on the two differing, so there is no ' +
        "degraded path: one model failure loses the step's judged verdict outright.",
    );
  }
  if (input.enabled && config.auditNetworkWhitelist === null) {
    input.warn(
      "AUDIT_NETWORK_WHITELIST is unset, so the network policy check is disabled " +
        "and no destination will ever be reported. Set it to a comma-separated " +
        "host list, or to an empty value to deny every destination.",
    );
  }

  const auditService = new AuditService({
    traceStore,
    auditStore,
    traceService: input.traceService,
    context: input.contextStore,
    runner: new ArkRunner(input.client, config, VERDICT_MAX_TOKENS),
    securityModel: config.auditSecurityModel,
    intentModel: config.auditIntentModel,
    networkWhitelist: config.auditNetworkWhitelist,
    memory: auditMemory,
    enabled: input.enabled,
    log: input.log,
  });
  auditService.start();

  return {
    auditStore,
    auditMemory,
    auditService,
    describeFor: (agentId: string) => {
      for (const trace of traceStore.listByAgent(agentId)) {
        if (isAuditorTrace(trace)) continue;
        const intent = auditStore.intentOf(trace.id);
        if (intent) return describeIntent(intent);
      }
      return "";
    },
    onInstructionsDrift: (event: InstructionsDrift) => {
      const trace = traceStore.get(event.traceId);
      if (!trace) return;
      auditStore.recordRunFinding(
        trace,
        instructionsDriftFinding(
          { id: randomUUID(), traceId: event.traceId, agentId: event.agentId },
          event.when,
        ),
        "",
        "degraded",
      );
    },
    flush: async () => {
      await auditStore.flush();
      await auditMemory.flush();
    },
  };
}

export type AuditMiddleware = Awaited<ReturnType<typeof createAuditMiddleware>>;

export { registerAuditRoutes } from "./routes.js";
export { AuditMemory } from "./audit-memory.js";
export { AuditService } from "./audit-service.js";
export { AuditStore } from "./audit-store.js";
export { type AuditHealth, type AuditTraceStep } from "./audit-model.js";
