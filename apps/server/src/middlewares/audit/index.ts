import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ArkClient } from "../../ark-client.js";
import { ArkRunner } from "../../ark-runner.js";
import type { AppConfig } from "../../config.js";
import type { InstructionsDrift } from "../../agent-service.js";
import type { ContextStore } from "../context/context-store.js";
import type { IntentMiddleware } from "../intent/index.js";
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
  intent: IntentMiddleware;
  onStoreError: (message: string, error?: unknown) => void;
  log: (message: string, error?: unknown) => void;
  warn: (message: string) => void;
}) {
  const { config, traceStore, intent } = input;

  const auditStore = new AuditStore(
    path.join(config.dataDirectory, "audits"),
    input.onStoreError,
  );
  await auditStore.initialize();
  // PLAN_AUDITOR's audit memory: agent-runs/{agentId}/{chatId}/ holding one
  // markdown record per audited step plus the meta index the analyses read.
  const auditMemory = new AuditMemory(
    path.join(config.dataDirectory, "agent-runs"),
    input.onStoreError,
  );

  // Two configurations silently weaken auditing without failing anything, so
  // say so once at boot rather than leaving an operator to infer it from
  // findings that never appear.
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

  // A classification that never produced a verdict is a middleware failure, not
  // an agent defect, so it is filed under audit-health beside a model outage.
  // Registered rather than passed to the intent middleware's constructor: the
  // report needs the store built above, and audit already depends on intent.
  intent.intentService.onClassifyFailed(({ agentId, traceId, attempts, failure }) => {
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
      intent.intentStore.latest(agentId)?.intentId ?? "",
      "failed",
    );
  });

  const auditService = new AuditService({
    traceStore,
    auditStore,
    traceService: input.traceService,
    context: input.contextStore,
    // The auditor runs through the same interface an Agent does. In-process
    // rather than by spawning a CLI, because step audits fire while the run
    // they judge is still going and have to keep up with it — but through the
    // interface all the same, so the trace pipeline records what it did.
    runner: new ArkRunner(input.client, config, VERDICT_MAX_TOKENS),
    securityModel: config.auditSecurityModel,
    intentModel: config.auditIntentModel,
    networkWhitelist: config.auditNetworkWhitelist,
    intent: intent.intentService,
    memory: auditMemory,
    enabled: input.enabled,
    log: input.log,
  });
  auditService.start();

  return {
    auditStore,
    auditMemory,
    auditService,
    // AGENTS.md is the spec the agent actually reads, it lives inside the
    // workspace, and the default sandbox is workspace-write — so the agent can
    // edit what governs it. Nothing else writes the file between runs, so a
    // difference means the platform is no longer the only author of the spec.
    onInstructionsDrift: (event: InstructionsDrift) => {
      const trace = traceStore.get(event.traceId);
      if (!trace) return;
      const intentId = intent.intentStore.latest(event.agentId)?.intentId ?? "";
      auditStore.recordRunFinding(
        trace,
        instructionsDriftFinding(
          { id: randomUUID(), traceId: event.traceId, agentId: event.agentId, intentId },
          event.when,
        ),
        intentId,
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
