import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AUDITOR_OBJECTIVE,
  describeIntent,
  type IntentDerivation,
  type IntentState,
} from "../intent/intent-model.js";
import { IntentReducer } from "../intent/intent-reducer.js";
import {
  buildIntentScopeUserMessage,
  intentClassification,
  INTENT_SCOPE_SYSTEM_PROMPT,
} from "../intent/intent-classifier.js";
import {
  hasJudgeableEvidence,
  isAuditorTrace,
  readAttribute,
  type TraceRecord,
  type TraceSpan,
} from "../trace/trace-model.js";
import type { TraceStore } from "../trace/trace-store.js";
import { detectSecretBindings } from "../trace/secrets.js";
import type { ContextStore } from "../context/context-store.js";
import type { AgentRunner } from "../../types.js";
import type { TraceService } from "../trace/trace-service.js";
import {
  auditorCallSpan,
  auditorSubagentType,
  AuditorModel,
  type AuditorCallAttempt,
} from "./auditor-model.js";
import {
  auditSteps,
  emitPolicyFindings,
  pushAuditorStatus,
  type AuditHealth,
  type AuditTraceStep,
} from "./audit-model.js";
import { AgentChatAuditor } from "./agent-chat-auditor.js";
import { BatchCaller } from "./batch-caller.js";
import { renderStepMarkdown, type AuditMemory } from "./audit-memory.js";
import type { AuditStore } from "./audit-store.js";
import { findRepeatedFailures, runDeterministicChecks } from "./deterministic.js";
import { reportForStep } from "./step-findings.js";
import {
  backTraceVerdict,
  buildAuditorStepContext,
  buildMetaContext,
  describeFollowThrough,
  followThroughVerdict,
  metaVerdict,
  questionText,
  unresolvedFollowThrough,
  BACK_TRACE_SYSTEM_PROMPT,
  FORWARD_TRACE_SYSTEM_PROMPT,
  META_STEP_SYSTEM_PROMPT,
  META_SYSTEM_PROMPT,
  type OpenQuestion,
} from "./run-checks.js";
import { activityFromSpan } from "./step-activity.js";
import { buildStepContext } from "./step-context.js";
import {
  buildNetworkContext,
  buildSecretContext,
  buildSinkContext,
  buildToolMisuseContext,
  injectionVerdict,
  intentStepVerdict,
  networkVerdict,
  secretRelevanceVerdict,
  sinkTargetsOf,
  sinkWriteVerdict,
  summaryVerdict,
  toolMisuseVerdict,
  INJECTION_SYSTEM_PROMPT,
  INTENT_STEP_SYSTEM_PROMPT,
  NETWORK_SYSTEM_PROMPT,
  SECRET_SYSTEM_PROMPT,
  SINK_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  TOOL_MISUSE_SYSTEM_PROMPT,
} from "./step-checks.js";

// How many of an auditor's own model-call spans a requested audit will judge.
// An auditor's trace holds roughly seven spans per Agent step, so this is
// sized for a long Agent run rather than for a handful of checks.
const MAX_REQUESTED_STEP_AUDITS = 150;

// The forward-trace shows the model every directive against every later step,
// so both sides are bounded. The step cap keeps the newest steps: an
// instruction is carried out soon after it is read far more often than at the
// very end of a long run.
const MAX_TRACED_DIRECTIVES = 10;
const MAX_TRACED_STEPS = 40;

// Runs whose run-level audit never happened, retried at boot. Bounded so a
// backlog cannot turn a restart into hundreds of model calls.
const MAX_RESUMED_RUN_AUDITS = 20;


// A run whose auditor fell back to the secondary model is not the same as one
// whose auditor worked, and neither is a defect in the agent. Recorded so the
// UI can say which of the three happened.
// Said the same way whether the step had a verdict to weigh or not, so one
// masking failure does not read as two different problems.
function leakedCredentialFinding(span: TraceSpan) {
  return (
    "A credential is readable in the auditor's own record for " +
    span.label +
    ". Masking runs before a span is stored, so this reached the auditor " +
    "unmasked."
  );
}

function healthOf(status: "completed" | "degraded" | "failed"): AuditHealth {
  if (status === "completed") return "ok";
  return status;
}

interface AuditServiceDeps {
  traceStore: TraceStore;
  auditStore: AuditStore;
  // The auditor executes through the same interface an Agent does, so its own
  // work is recorded as a trace and can be audited in turn.
  runner: AgentRunner;
  // Opens and closes the auditor's own trace. Optional so a test that only
  // cares about findings does not have to stand up the trace pipeline.
  traceService?: TraceService;
  securityModel: string;
  intentModel: string;
  // null disables the network policy check; [] denies every destination.
  networkWhitelist: string[] | null;
  // Identifies the spec each step is judged against. Optional so a test can
  // stub the classifier; production wires it through the auditor's runner.
  intentReducer?: IntentReducer;
  // Prior-run context. Always populated, model or no model — the auditor reads
  // from it and enriches it, but never owns it.
  context?: ContextStore;
  // Where each audited step's record is written. Optional so a test that only
  // cares about findings does not have to provide a filesystem.
  memory?: AuditMemory;
  enabled: boolean;
  // How many of an auditor's steps a requested audit will judge. Defaulted so
  // existing callers need no change, and tunable for the same reason the batch
  // settings are: what is affordable depends on the deployment.
  requestedStepBudget?: number;
  // BatchCaller tuning. Defaulted so existing callers need no change.
  batchSize?: number;
  batchIntervalSeconds?: number;
  batchConcurrency?: number;
  log?: (message: string, error?: unknown) => void;
}

// Queue depth past which the backlog is worth saying out loud. Every audit in
// the process runs on one chain behind a 60s client timeout, so a burst of runs
// puts findings arbitrarily far behind the work they describe. Reported rather
// than fixed by widening the chain: ordering is what keeps a step judged
// against the spec that preceded it.
const QUEUE_DEPTH_WARNING = 25;

// Modest defaults: audits are advisory and bounded by the provider's rate
// limit, not by how fast findings can be produced.
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_BATCH_INTERVAL = 0.25;
const DEFAULT_BATCH_CONCURRENCY = 2;

// The auditor is a deliberately separate stage: it subscribes to trace store
// notifications, re-reads persisted (already redacted) trace data, and writes
// only to its own store. It never mutates traces and a failure here never
// blocks a run.
// The forward trace and the backtrace look at the same suspicions from
// opposite directions, so both can land on the same instruction — one saying a
// later step carried it out, the other that nothing the user asked for accounts
// for it. That is one problem, and reporting it twice inflates the run's count
// and reads as two separate failures.
//
// The forward trace wins because it names the step that did it. Matched on the
// quoted instruction rather than on the finding text, since the two phrase
// their conclusions differently by design.
function withoutDuplicatesOf(
  reported: AuditTraceStep[],
  candidates: AuditTraceStep[],
): AuditTraceStep[] {
  const already = reported
    .filter((finding) => finding.category === "security")
    .map((finding) => finding.finding.toLowerCase());
  if (already.length === 0) return candidates;
  return candidates.filter((candidate) => {
    // Only a confirmed follow-through can duplicate one: a suspicion that
    // survived both passes is still worth saying.
    if (candidate.type !== "warning" || candidate.category !== "security") {
      return true;
    }
    const directive = quotedDirective(candidate.finding);
    if (directive === null) return true;
    return !already.some((seen) => seen.includes(directive));
  });
}

// The instruction both checks quote, pulled out of the sentence each wraps it
// in. Returns null for a finding that is not about a directive at all.
function quotedDirective(finding: string): string | null {
  const marker = "untrusted content";
  const at = finding.toLowerCase().indexOf(marker);
  if (at === -1) return null;
  const rest = finding.slice(at + marker.length);
  const colon = rest.indexOf(": ");
  if (colon === -1) return null;
  const directive = rest.slice(colon + 2).split(". ")[0] ?? "";
  const trimmed = directive.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function judgedIntent(
  chat: AgentChatAuditor,
  trace: TraceRecord,
): IntentState {
  const state = chat.intentState;
  const copy = state
    ? { ...state, extended: [...state.extended] }
    : { instructions: "", objective: "", extended: [] };
  if (copy.objective.length === 0) copy.objective = trace.prompt;
  return copy;
}

function instructionsOf(trace: TraceRecord) {
  const run = trace.spans.find((span) => span.kind === "run");
  return run ? readAttribute(run, "instructions") : "";
}

export class AuditService {
  // PLAN_AUDITOR's BatchCaller. Safe to run audits concurrently because the
  // identifier phase pins the spec on the chat audit before any step is scored,
  // so out-of-order completion still reports the spec the step was judged under.
  private readonly batch: BatchCaller;
  private warnedAboutDepth = false;
  // Asking the audit model, and living with what comes back. Holds the memo of
  // models the account has not activated, which is why there is one of these
  // per process rather than per chat.
  private readonly model: AuditorModel;
  // PLAN_AUDITOR's AgentChatAuditor, one per chat. Holds the identity its
  // findings are stamped with, the folder its artifacts go to, and the state
  // the run-level checks need — the meta-audit guard, and how many step
  // audits are still in flight.
  private readonly auditors = new Map<string, AgentChatAuditor>();

  constructor(private readonly deps: AuditServiceDeps) {
    this.model = new AuditorModel(deps.runner, deps.log);
    this.batch = new BatchCaller({
      bufferSize: deps.batchSize ?? DEFAULT_BATCH_SIZE,
      bufferInterval: deps.batchIntervalSeconds ?? DEFAULT_BATCH_INTERVAL,
      maxBatchesConcurrency: deps.batchConcurrency ?? DEFAULT_BATCH_CONCURRENCY,
      log: deps.log,
    });
  }

  start() {
    if (!this.deps.enabled) return;
    this.deps.traceStore.on("span", ({ trace, span }) => {
      if (isAuditorTrace(trace)) return;
      if (!this.shouldAuditStep(span, trace)) return;
      const chat = this.auditorFor(trace);
      chat.openStep();
      this.enqueue(() =>
        this.identifyFor(chat, trace)
          .then(() => chat.auditStep(span.id))
          .finally(() => chat.closeStep()),
      );
    });
    this.deps.traceStore.on("trace-completed", ({ trace }) => {
      if (isAuditorTrace(trace)) return;
      const chat = this.auditorFor(trace);
      this.enqueue(() =>
        this.identifyFor(chat, trace).then(() => chat.auditAll()),
      );
    });
    this.resumeUnfinishedRunAudits();
  }

  // A run interrupted by a restart is rewritten from running to failed by
  // TraceStore.initialize, directly on the record rather than through
  // updateTrace, so no trace-completed is ever emitted for it — and this
  // subscription is installed after that rewrite has already happened. Without
  // this sweep a crashed run is never judged at the run level and nothing says
  // so. Bounded because a first boot with auditing newly enabled would
  // otherwise queue a model call for every trace ever recorded.
  private resumeUnfinishedRunAudits() {
    const pending = this.deps.traceStore
      .list()
      .filter(
        (trace) =>
          !isAuditorTrace(trace) &&
          trace.status !== "running" &&
          !this.deps.auditStore.isRunComplete(trace.id),
      );
    for (const trace of pending.slice(0, MAX_RESUMED_RUN_AUDITS)) {
      const chat = this.auditorFor(trace);
      this.enqueue(() =>
        this.identifyFor(chat, trace).then(() => chat.auditAll()),
      );
    }
    const skipped = pending.length - MAX_RESUMED_RUN_AUDITS;
    if (skipped > 0) {
      this.deps.log?.(
        skipped +
          " older runs ended without a run-level audit and were not resumed; " +
          "only the newest " +
          MAX_RESUMED_RUN_AUDITS +
          " are retried at boot.",
      );
    }
  }

  // Tests await this to observe queued audits without polling.
  idle() {
    return this.batch.idle();
  }

  // The auditor for a chat, created on first use. Everything a chat's audits
  // need to agree about lives on it rather than in maps keyed by trace id.
  private auditorFor(trace: TraceRecord): AgentChatAuditor {
    const existing = this.auditors.get(trace.id);
    if (existing) return existing;
    const created = new AgentChatAuditor(
      trace.agentId,
      trace.id,
      this.deps.memory?.root ?? "",
      {
        runStepAudit: (chat, spanId) => this.stepAudit(chat, spanId),
        runAll: (chat) => this.auditAll(chat),
        runRequestedAudit: (chat) => this.requestedAudit(chat),
      },
    );
    this.auditors.set(trace.id, created);
    return created;
  }

  // How far behind the auditor is, and the worst it has been. Exposed so the
  // lag between an action and its finding is observable rather than inferred.
  backlog() {
    return this.batch.backlog();
  }

  private enqueue(task: () => Promise<void>) {
    const depth = this.batch.depth();
    // Said once per backlog, not per task: a burst would otherwise bury the log
    // it is trying to draw attention to.
    if (depth >= QUEUE_DEPTH_WARNING && !this.warnedAboutDepth) {
      this.warnedAboutDepth = true;
      this.deps.log?.(
        depth +
          " audits are queued. Findings will lag the actions they describe " +
          "until the backlog drains.",
      );
    }
    if (this.batch.depth() === 0) this.warnedAboutDepth = false;
    void this.batch.queue(task);
  }

  private shouldAuditStep(span: TraceSpan, trace: TraceRecord) {
    if (span.kind === "user_action" && span.name === "user.prompt") return true;
    // The plan is where an injected objective shows up first — the agent says
    // what it intends before any tool carries it out. Gated on output so the
    // span is judged once, when it has something to judge: api_request appends
    // the span before the model has said anything.
    if (span.kind === "model_call") {
      return readAttribute(span, "output").length > 0;
    }
    // A subagent's reply is external content that can carry an injected
    // objective, so it is audited like any other tool result. A synthesized
    // projection of exec_command output is already covered by that tool span.
    //
    // Nothing currently emits this span — a reply arrives as an ordinary
    // tool_call — so this branch does not fire today. It is kept deliberately
    // rather than deleted: the span shape existed in an earlier version (the
    // web still hides synthesized ones for older traces) and the subagent
    // visualizer work may reinstate it. Deleting the branch would silently drop
    // external content out of the audit the day it comes back.
    if (span.kind === "system" && span.name === "subagent.result") {
      return span.attributes.synthesized !== true;
    }
    if (span.kind !== "tool_call") return false;
    if (span.status === "running") return false;
    // A tool denied at the decision is final immediately but carries only its
    // name: arguments and output arrive with the result. Judging it here judged
    // a bare tool name, so it waits for the payload — or, if the run ends
    // without one, for the sweep that re-announces it with the run's verdict.
    return hasJudgeableEvidence(span) || trace.status !== "running";
  }

  // Identifier phase: derive the spec this chat will be judged against, and
  // the spec the auditor itself is working under, before any step is scored.
  private async identifyFor(chat: AgentChatAuditor, trace: TraceRecord) {
    await chat.identifyIntent(() => this.deriveBoth(trace));
  }

  private async deriveBoth(trace: TraceRecord): Promise<IntentDerivation> {
    // Open the auditor's own run before reducing, so identifier calls for
    // the subject land on that run rather than on the subject itself.
    const auditTraceId = this.openAuditTrace(trace);
    const target = await this.deriveFor(trace);
    this.deps.auditStore.recordIntent(trace, target);

    const auditTrace =
      auditTraceId && auditTraceId !== trace.id
        ? this.deps.traceStore.get(auditTraceId)
        : null;
    if (auditTrace) {
      const auditor = await this.deriveFor(auditTrace);
      this.deps.auditStore.recordIntent(auditTrace, auditor);
    }
    return target;
  }

  // Same reducer for both agents. The target rebases current instructions onto
  // prior audit derivations and this run's message. The auditor rebases its
  // own spec — "Audit the target agent." — the same way.
  private async deriveFor(trace: TraceRecord): Promise<IntentDerivation> {
    const auditor = isAuditorTrace(trace);
    return this.reducerFor(trace).reduce({
      instructions: auditor
        ? AUDITOR_OBJECTIVE
        : instructionsOf(trace) || trace.prompt,
      prior: this.priorIntent(trace),
      message: auditor ? AUDITOR_OBJECTIVE : trace.prompt,
    });
  }

  private reducerFor(trace: TraceRecord): IntentReducer {
    return (
      this.deps.intentReducer ??
      new IntentReducer((state, message) =>
        this.classifyScope(trace, state, message),
      )
    );
  }

  private priorIntent(trace: TraceRecord): IntentState | null {
    for (const candidate of this.deps.traceStore.listByAgent(trace.agentId)) {
      if (candidate.id === trace.id) continue;
      if (isAuditorTrace(candidate) !== isAuditorTrace(trace)) continue;
      if (candidate.startedAt >= trace.startedAt) continue;
      const intent = this.deps.auditStore.intentOf(candidate.id);
      if (intent) return intent;
    }
    return null;
  }

  private async classifyScope(
    trace: TraceRecord,
    state: IntentState,
    message: string,
  ) {
    const user = buildIntentScopeUserMessage(state, message);
    const { verdict, attempts, status, failure } = await this.model.complete(
      this.auditorRun(trace),
      this.deps.intentModel,
      this.deps.securityModel !== this.deps.intentModel
        ? this.deps.securityModel
        : null,
      INTENT_SCOPE_SYSTEM_PROMPT,
      user,
      intentClassification,
    );
    this.recordAuditorAttempts(trace, {
      name: "audit.identify",
      label: "Identify intent",
      targetSpanId: null,
      prompt: user,
      attempts,
      usedFallback: status === "degraded",
    });
    if (!verdict) {
      this.deps.log?.(
        "intent identifier failed" + (failure ? ": " + failure : ""),
      );
      return null;
    }
    if (verdict.classification === "NO_CHANGE") {
      return {
        ...verdict,
        extendedIntent: [],
        removedIntent: [],
        objective: null,
      };
    }
    return verdict;
  }

  private priorPromptInjectionQuotes(traceId: string): string[] {
    return this.injectionsInTrace(traceId).map((entry) => entry.quote);
  }

  // The same findings, but keeping which step each was found in — the
  // forward-trace needs it to know which steps count as "later".
  private injectionsInTrace(traceId: string) {
    const prefix = "prompt-injection: ";
    return this.deps.auditStore
      .listByTrace(traceId)
      .filter((step) => step.finding.startsWith(prefix))
      .map((step) => ({
        spanId: step.spanId,
        quote: step.finding.slice(prefix.length).trim(),
      }))
      .filter((entry) => entry.quote.length > 0);
  }

  // Every step-level intent suspicion in the run. These are what auditAll's
  // backtrace is for: the step audit saw something that might not fit the
  // objective, and only the run as a whole can say whether it did.
  private deviationSuspicions(traceId: string): OpenQuestion[] {
    return this.deps.auditStore
      .listByTrace(traceId)
      .filter(
        (step) => step.type === "suspicion" && step.category === "intent-check",
      )
      .slice(0, MAX_TRACED_DIRECTIVES)
      .map((step) => ({ kind: "deviation" as const, action: step.finding }));
  }

  // PLAN_AUDITOR's auditAll check 2 reads "steps that have suspicions", which
  // includes the instructions check 4 found in untrusted content. Taken from
  // the store rather than from the forward trace's leftovers, so the backtrace
  // examines them on its own evidence — and still examines them when the
  // forward trace produced no verdict at all.
  private injectionSuspicions(traceId: string): OpenQuestion[] {
    return this.injectionsInTrace(traceId)
      .slice(0, MAX_TRACED_DIRECTIVES)
      .map((entry) => ({
        kind: "follow-through" as const,
        directive: entry.quote,
        step: "",
        evidence: "",
      }));
  }

  // What the per-step audits already reported as followed-through, so the
  // forward-trace does not say it a second time in different words.
  private reportedFollowThrough(traceId: string): string[] {
    const prefix = "The agent appears to have carried out a previously injected instruction: ";
    return this.deps.auditStore
      .listByTrace(traceId)
      .map((step) => step.finding)
      .filter((finding) => finding.startsWith(prefix))
      .map((finding) => finding.slice(prefix.length).trim().toLowerCase());
  }

  // PLAN_AUDITOR's auditStep: checks 0-6, concurrently, each with its own
  // evidence and its own auditor span. Four are conditional — the spec gates 5
  // and 6 on the step being a tool call or a sink write, and gates 2 on a URI
  // existing at all — so the deterministic pass below decides which are worth
  // asking before any of them is paid for.
  private async stepAudit(chat: AgentChatAuditor, spanId: string) {
    const traceId = chat.chatId;
    const opened = this.deps.traceStore.get(traceId);
    if (!opened) return;
    await this.identifyFor(chat, opened);
    const trace = this.deps.traceStore.get(traceId);
    const span = trace?.spans.find((item) => item.id === spanId);
    if (!trace || !span) return;

    // Runs first and without a model, so a whitelist violation or a leaked
    // credential is still reported when the audit model is unreachable.
    const activity = activityFromSpan(span, trace);
    const priorPromptInjections = this.priorPromptInjectionQuotes(traceId);
    const deterministic = runDeterministicChecks(activity, {
      whitelist: this.deps.networkWhitelist,
    });
    const intent = judgedIntent(chat, trace);

    const stepPrompt = buildStepContext({
      trace,
      span,
      intent,
      activity,
      deterministic,
      priorPromptInjections,
      priorContext: this.deps.context?.priorFor(traceId)?.summary ?? "",
    });

    const secretTypes = [
      ...new Set(deterministic.secretExposures.map((entry) => entry.secretType)),
    ];
    const toolName =
      typeof span.attributes.toolName === "string"
        ? span.attributes.toolName
        : span.name.startsWith("tool.")
          ? span.name.slice("tool.".length)
          : "";
    const argumentsText =
      typeof span.attributes.arguments === "string"
        ? span.attributes.arguments
        : "";
    const sinkTargets = sinkTargetsOf(activity);

    // Checks 0, 3 and 4 always run; the rest only when their subject exists.
    const [
      summaryCheck,
      intentCheck,
      injectionCheck,
      secretCheck,
      networkCheck,
      toolCheck,
      sinkCheck,
    ] = await Promise.all([
      this.stepCheck(trace, spanId, {
        name: "audit.step.summary",
        label: "Summarize · " + span.label,
        system: SUMMARY_SYSTEM_PROMPT,
        user: stepPrompt,
        schema: summaryVerdict,
      }),
      this.stepCheck(trace, spanId, {
        name: "audit.step.intent",
        label: "Intent · " + span.label,
        system: INTENT_STEP_SYSTEM_PROMPT,
        user: stepPrompt,
        schema: intentStepVerdict,
      }),
      this.stepCheck(trace, spanId, {
        name: "audit.step.injection",
        label: "Injection · " + span.label,
        system: INJECTION_SYSTEM_PROMPT,
        user: stepPrompt,
        schema: injectionVerdict,
      }),
      secretTypes.length === 0
        ? null
        : this.stepCheck(trace, spanId, {
            name: "audit.step.secrets",
            label: "Secret relevance · " + span.label,
            system: SECRET_SYSTEM_PROMPT,
            user: buildSecretContext(secretTypes, activity),
            schema: secretRelevanceVerdict,
          }),
      activity.networkCalls.length === 0
        ? null
        : this.stepCheck(trace, spanId, {
            name: "audit.step.network",
            label: "Network · " + span.label,
            system: NETWORK_SYSTEM_PROMPT,
            user: buildNetworkContext(activity),
            schema: networkVerdict,
          }),
      span.kind !== "tool_call" || argumentsText.length === 0
        ? null
        : this.stepCheck(trace, spanId, {
            name: "audit.step.tool",
            label: "Tool misuse · " + span.label,
            system: TOOL_MISUSE_SYSTEM_PROMPT,
            user: buildToolMisuseContext(toolName, argumentsText, activity),
            schema: toolMisuseVerdict,
          }),
      sinkTargets.length === 0
        ? null
        : this.stepCheck(trace, spanId, {
            name: "audit.step.sinks",
            label: "Sink writes · " + span.label,
            system: SINK_SYSTEM_PROMPT,
            user: buildSinkContext(sinkTargets),
            schema: sinkWriteVerdict,
          }),
    ]);

    const report = reportForStep(deterministic, {
      summary: summaryCheck,
      intent: intentCheck,
      injection: injectionCheck,
      secrets: secretCheck,
      network: networkCheck,
      tool: toolCheck,
      sinks: sinkCheck,
    });

    const steps = auditSteps(
      { id: randomUUID(), traceId, agentId: trace.agentId, spanId },
      (push) => {
        emitPolicyFindings(push, report.policies);
        for (const tag of report.tags) {
          push(
            "warning",
            "security",
            tag + (report.reason ? ": " + report.reason : ""),
          );
        }
        pushAuditorStatus(push, report.status, report.failure);
      },
    );
    this.deps.auditStore.recordSpan(
      trace,
      spanId,
      steps,
      "",
      healthOf(report.status),
    );
    await this.rememberStep(trace, span, steps, {
      summary: report.summary,
      error: report.failure ?? "",
    });
  }

  // One check: its own model call, its own auditor span, its own verdict. The
  // label travels with the result so a failure can say which question went
  // unanswered.
  // Who the auditor is running as, for the runner. The workspace is the chat's
  // memory folder — the in-process runner ignores it, but it is where this
  // auditor's artifacts already go, so it is the honest answer rather than a
  // placeholder.
  private auditorRun(trace: TraceRecord) {
    return {
      agentId: trace.agentId,
      workspacePath: this.auditorFor(trace).memoryFolderPath,
    };
  }

  private async stepCheck<Schema extends z.ZodType>(
    trace: TraceRecord,
    spanId: string,
    check: {
      name: string;
      label: string;
      system: string;
      user: string;
      schema: Schema;
    },
  ) {
    const { verdict, status, failure, attempts } = await this.model.complete(
      this.auditorRun(trace),
      this.deps.securityModel,
      this.deps.intentModel,
      check.system,
      check.user,
      check.schema,
    );
    this.recordAuditorAttempts(trace, {
      name: check.name,
      label: check.label,
      targetSpanId: spanId,
      prompt: check.user,
      attempts,
      usedFallback: status === "degraded",
    });
    return { verdict, status, failure, label: check.label };
  }

  // The step's own record in the chat's audit memory: a markdown file a person
  // reads, and an entry in the index the run-level analyses query. Written
  // after the finding is stored, and never allowed to fail the audit — a
  // missing artifact is worth less than the finding it describes.
  private async rememberStep(
    trace: TraceRecord,
    span: TraceSpan,
    steps: AuditTraceStep[],
    outcome: { summary: string; error: string },
  ) {
    const memory = this.deps.memory;
    if (!memory) return;
    const entry = {
      summary: outcome.summary,
      findings: steps,
      error: outcome.error,
    };
    await memory.writeStep(
      trace.agentId,
      trace.id,
      span.id,
      renderStepMarkdown({
        stepId: span.id,
        label: span.label,
        summary: entry.summary,
        findings: entry.findings,
        error: entry.error,
      }),
    );
    await memory.updateMeta(trace.agentId, trace.id, span.id, entry);
  }

  // Reads the run back as an ordered list of step summaries and asks whether
  // any step carried out an instruction that arrived in untrusted content.
  // Returns null when there is nothing to trace, so a run with no injected
  // instructions costs no model call.
  //
  // What it could not settle is handed to the backtrace rather than reported
  // here: looking only at what came *after* a directive cannot tell "the agent
  // obeyed the file" from "the user asked for this anyway", and answering that
  // needs the steps that came before.
  private async forwardTrace(
    trace: TraceRecord,
  ): Promise<AuditTraceStep[]> {
    const memory = this.deps.memory;
    if (!memory) return [];
    const injections = this.injectionsInTrace(trace.id).slice(
      0,
      MAX_TRACED_DIRECTIVES,
    );
    if (injections.length === 0) return [];

    const meta = await memory.readMeta(trace.agentId, trace.id);
    const positionOf = new Map(
      trace.spans.map((span, index) => [span.id, index] as const),
    );
    const directives = injections.map((entry) => ({
      quote: entry.quote,
      // A run-level finding carries no span. Treating it as step 0 makes every
      // recorded step count as later, which is the safe reading.
      at: (entry.spanId ? positionOf.get(entry.spanId) ?? 0 : 0) + 1,
    }));
    const earliest = Math.min(...directives.map((entry) => entry.at));
    const later = trace.spans
      .map((span, index) => ({ span, number: index + 1 }))
      .filter(({ span, number }) => number > earliest && meta[span.id])
      .slice(-MAX_TRACED_STEPS);
    // Nothing happened after the instruction appeared, so nothing can have
    // carried it out.
    if (later.length === 0) return [];

    const user = [
      "## Directives found in untrusted content",
      ...directives.map(
        (entry) => "- [found at step " + entry.at + "] " + entry.quote,
      ),
      "",
      "## What each later step did",
      ...later.map(
        ({ span, number }) =>
          number +
          ". " +
          span.label +
          " — " +
          (meta[span.id]?.summary || "(no summary recorded for this step)"),
      ),
    ].join("\n");

    const { verdict, status, failure, attempts } = await this.model.complete(
      this.auditorRun(trace),
      this.deps.securityModel,
      this.deps.intentModel !== this.deps.securityModel
        ? this.deps.intentModel
        : null,
      FORWARD_TRACE_SYSTEM_PROMPT,
      user,
      followThroughVerdict,
    );
    this.recordAuditorAttempts(trace, {
      name: "audit.forward-trace",
      label: "Forward trace · " + directives.length + " directive(s)",
      targetSpanId: null,
      prompt: user,
      attempts,
      usedFallback: status === "degraded",
    });

    // Already said once, per step. Saying it again in the model's new words
    // would double-count the same follow-through.
    const alreadyReported = this.reportedFollowThrough(trace.id);
    const isNew = (directive: string) => {
      const lower = directive.trim().toLowerCase();
      if (lower.length === 0) return false;
      return !alreadyReported.some(
        (seen) => seen.includes(lower) || lower.includes(seen),
      );
    };
    const findings = auditSteps(
      {
        id: randomUUID(),
        traceId: trace.id,
        agentId: trace.agentId,
        spanId: null,
      },
      (push) => {
        for (const entry of verdict?.carriedOut ?? []) {
          if (!isNew(entry.directive)) continue;
          push(
            "warning",
            "security",
            "A later step carried out an instruction that came from untrusted " +
              "content: " +
              entry.directive +
              ". " +
              describeFollowThrough(entry),
          );
        }
        pushAuditorStatus(push, status, failure);
      },
    );
    return findings;
  }

  // PLAN_AUDITOR's auditAll check 2. Every step was judged on its own, which
  // is the only way to judge one while a run is still going but also the reason
  // the step audit over-flags: an action that serves the objective can look
  // unmotivated next to the one step it appears in. This reads the steps that
  // led up to each open question and asks whether anything the user actually
  // asked for accounts for it.
  //
  // A question the model cannot resolve — or never got to, because the call
  // failed — is still reported. "The record does not settle this" is the whole
  // point of the severity, so losing one to a model outage would be the single
  // outcome worse than reporting it.
  private async backTrace(
    chat: AgentChatAuditor,
    trace: TraceRecord,
    open: OpenQuestion[],
  ) {
    const identity = {
      id: randomUUID(),
      traceId: trace.id,
      agentId: trace.agentId,
      spanId: null,
    };
    const memory = this.deps.memory;
    // Without the step summaries there is nothing to walk back through. The
    // questions keep the severity they already had rather than disappearing:
    // the step-level suspicions are already in the store, and an unresolved
    // follow-through is re-stated so it is not lost with the forward trace.
    if (!memory || open.length === 0) {
      return auditSteps(identity, (push) => {
        for (const question of open) {
          if (question.kind === "deviation") continue;
          push("suspicion", "security", unresolvedFollowThrough(question));
        }
      });
    }

    const meta = await memory.readMeta(trace.agentId, trace.id);
    const intent = judgedIntent(chat, trace);
    const history = trace.spans
      .map((span, index) => ({ span, number: index + 1 }))
      .filter(({ span }) => meta[span.id])
      .slice(-MAX_TRACED_STEPS);

    const user = [
      "## What the user asked for",
      describeIntent(intent),
      "",
      "## What the run did, in order",
      ...history.map(
        ({ span, number }) =>
          number +
          ". " +
          span.label +
          " — " +
          (meta[span.id]?.summary || "(no summary recorded for this step)"),
      ),
      "",
      "## Open questions",
      ...open.map((question) => "- " + questionText(question)),
    ].join("\n");

    const { verdict, status, failure, attempts } = await this.model.complete(
      this.auditorRun(trace),
      this.deps.securityModel,
      this.deps.intentModel !== this.deps.securityModel
        ? this.deps.intentModel
        : null,
      BACK_TRACE_SYSTEM_PROMPT,
      user,
      backTraceVerdict,
    );
    this.recordAuditorAttempts(trace, {
      name: "audit.back-trace",
      label: "Back trace · " + open.length + " open",
      targetSpanId: null,
      prompt: user,
      attempts,
      usedFallback: status === "degraded",
    });

    // The model echoes the question back, so answers are matched to questions
    // by their text rather than by position — a model that drops or reorders an
    // entry would otherwise attach its reasoning to the wrong finding.
    const decisionFor = (question: OpenQuestion) => {
      const lower = questionText(question).trim().toLowerCase();
      return (verdict?.resolved ?? []).find((entry) => {
        const candidate = entry.question.trim().toLowerCase();
        if (candidate.length === 0) return false;
        return candidate.includes(lower) || lower.includes(candidate);
      });
    };

    return auditSteps(identity, (push) => {
      for (const question of open) {
        const decision = decisionFor(question);
        // Answered as legitimate. Nothing is pushed: for a deviation the
        // step-level suspicion already stands as the unconfirmed record, and
        // re-stating a question the auditor has answered is noise.
        if (decision?.because === "user") continue;

        if (decision?.because === "unexplained") {
          const why = decision.reason ? " " + decision.reason : "";
          push(
            "warning",
            question.kind === "deviation" ? "intent-check" : "security",
            question.kind === "deviation"
              ? "Nothing the user asked for accounts for this, across the run: " +
                  question.action +
                  why
              : "A later step carried out an instruction that came from " +
                  "untrusted content, and nothing the user asked for accounts " +
                  "for it: " +
                  question.directive +
                  ". " +
                  describeFollowThrough(question) +
                  why,
          );
          continue;
        }

        // Still open. A deviation already has its suspicion in the store from
        // the step audit, so only the follow-through needs re-stating.
        if (question.kind === "follow-through") {
          push("suspicion", "security", unresolvedFollowThrough(question));
        }
      }
      pushAuditorStatus(push, status, failure);
    });
  }

  // PLAN_AUDITOR's auditAll: repeated failures, then backtrace of open
  // suspicions and forward trace of prompt injections, concurrently. There is
  // no separate whole-run intent diagnosis — each step was already judged in
  // isolation, and these three checks are how those suspicions are tied
  // together once the chat has finished.
  private async auditAll(chat: AgentChatAuditor) {
    const traceId = chat.chatId;
    const opened = this.deps.traceStore.get(traceId);
    if (!opened) return;
    await this.identifyFor(chat, opened);
    const trace = this.deps.traceStore.get(traceId);
    if (!trace) return;

    let followThrough: AuditTraceStep[] = [];
    try {
      await chat.awaitSteps();
      // Re-read: the wait above is exactly the window in which the last step
      // audits appended their auditor spans and findings.
      const settled = this.deps.traceStore.get(traceId) ?? trace;
      // PLAN_AUDITOR's auditAll 2 and 3, concurrently, because they are two
      // independent looks at the same suspicions rather than one feeding the
      // other. The forward trace reads what happened *after* an instruction
      // appeared; the backtrace reads what came before and what the user asked
      // for. Chaining them meant a forward trace that produced no verdict took
      // the question down with it — the backtrace was never told there was one.
      const open: OpenQuestion[] = [
        ...this.deviationSuspicions(traceId),
        ...this.injectionSuspicions(traceId),
      ];
      const [forward, back] = await Promise.all([
        this.forwardTrace(settled),
        open.length === 0
          ? Promise.resolve<AuditTraceStep[]>([])
          : this.backTrace(chat, settled, open),
      ]);
      followThrough = forward.concat(withoutDuplicatesOf(forward, back));
    } catch (error) {
      this.deps.log?.("follow-through trace failed for run " + traceId, error);
    }

    this.deps.auditStore.recordRun(
      trace,
      auditSteps(
        {
          id: randomUUID(),
          traceId,
          agentId: trace.agentId,
          spanId: null,
        },
        (push) => {
          // Needs no model, so it still reports when Ark is unreachable.
          for (const repeat of findRepeatedFailures(trace)) {
            push(
              "warning",
              "reliability",
              "The agent retried " +
                repeat.toolName +
                " " +
                repeat.count +
                " times after it had already failed" +
                (repeat.attempt ? ": " + repeat.attempt : "."),
            );
          }
        },
      ).concat(followThrough),
      "",
      "",
      "ok",
    );
    // The run-level pass is the last thing an auditor does for a chat, so this
    // is where its own run ends. Until it does the auditor's trace reads as
    // still running, and a trace that never ends is one nobody can audit.
    this.closeAuditTrace(chat);
  }

  // Every model attempt this auditor made, as spans on the auditor's own trace.
  //
  // They used to be stashed in an array on the audited trace's document, which
  // made them unreachable by everything that understands a trace — including
  // the auditor itself. Recording them here is what makes an auditor's run a
  // thing that can be opened, read and judged like any other.
  private recordAuditorAttempts(
    trace: TraceRecord,
    input: {
      name: string;
      label: string;
      targetSpanId: string | null;
      prompt: string;
      attempts: AuditorCallAttempt[];
      usedFallback: boolean;
    },
  ) {
    const traceService = this.deps.traceService;
    if (!traceService) return;
    const dest = this.destinationForAttempts(trace);
    if (dest === null) return;
    const subagentType = auditorSubagentType(input.name);
    input.attempts.forEach((attempt, index) => {
      const fallback = input.usedFallback && index === input.attempts.length - 1;
      traceService.recordModelCall(
        dest,
        auditorCallSpan({
          traceId: dest,
          name: input.name,
          label: fallback ? input.label + " (fallback)" : input.label,
          // Still the span on the *audited* trace, not on this one. It is the
          // question's subject, and the UI resolves it against the trace this
          // auditor was judging.
          targetSpanId: input.targetSpanId,
          prompt: input.prompt,
          attempt,
          fallback,
        }),
        subagentType ? { subagentType } : undefined,
      );
    });
  }

  // Where this auditor's model calls are recorded. A chat that is already
  // judging a subject writes to its own run. Identifying the auditor's spec
  // during the parent's pass writes onto that auditor run — it is not a
  // nested audit of the auditor.
  private destinationForAttempts(subject: TraceRecord): string | null {
    const judging = this.auditors.get(subject.id);
    if (judging?.auditTraceId) return judging.auditTraceId;
    if (isAuditorTrace(subject)) return subject.id;
    return this.openAuditTrace(subject);
  }

  // The auditor's own trace for this chat, opened on first use. One per audited
  // chat rather than one per check: an auditor's run is the whole pass it makes
  // over a trace, which is the unit AgentChatAuditor already bounds.
  private openAuditTrace(trace: TraceRecord): string | null {
    const traceService = this.deps.traceService;
    if (!traceService) return null;
    const chat = this.auditorFor(trace);
    return chat.openAuditTrace(() => {
      const auditTraceId = randomUUID();
      traceService.onRunStart(
        {
          // Filed under the audited agent's id so findings, memory and the
          // archive sit with the run they are about. The auditor is still a
          // separate agent: its spec is AUDITOR_OBJECTIVE, and auditOf is
          // what the depth-0 gate reads.
          id: trace.agentId,
          name: "Auditor",
          instructions: AUDITOR_OBJECTIVE,
          codexThreadId: null,
        },
        {
          id: auditTraceId,
          prompt: "Audit of trace " + trace.id,
          auditOf: trace.id,
          auditDepth: trace.auditDepth + 1,
        },
      );
      return auditTraceId;
    });
  }

  // Closes the auditor's trace once its pass over the run is finished. Called
  // from the run-level audit, which is the last thing any pass does.
  private closeAuditTrace(chat: AgentChatAuditor) {
    const auditTraceId = chat.closeAuditTrace();
    if (!auditTraceId) return;
    this.deps.traceService?.onRunEnd(auditTraceId, {
      status: "completed",
      output: "Audit of trace " + chat.chatId + " complete.",
    });
  }

  // Audits any trace on request, whatever produced it.
  //
  // This is the only entry point above depth 0, and it is uniform: auditing an
  // Agent's run and auditing an auditor's run are the same operation on
  // different traces. Level N+1 is this method called on the trace level N
  // produced, so the stack goes as deep as someone chooses to click and stops
  // the moment they stop.
  //
  // Returns the auditor trace it wrote, which is what the caller navigates to.
  async audit(traceId: string) {
    const trace = this.deps.traceStore.get(traceId);
    if (!trace) return null;
    // The one-at-a-time guard lives on the chat's own auditor, so a second
    // trigger cannot judge a half-written record.
    const outcome = await this.auditorFor(trace).auditOnRequest();
    if (outcome === "in-flight") return "in-flight" as const;
    return {
      traceId,
      auditTraceId: this.deps.traceStore.auditorTraceFor(traceId),
    };
  }

  private async requestedAudit(chat: AgentChatAuditor) {
    const trace = this.deps.traceStore.get(chat.chatId);
    if (!trace) return;
    // An Agent's run is re-judged the way it was judged the first time. An
    // auditor's run gets the questions that are worth asking of an auditor —
    // whether it claimed more than its evidence supports, and what it walked
    // past — because those are the only ones its spans can answer.
    if (!isAuditorTrace(trace)) {
      // Asking again answers the same question again. The automatic pass runs
      // once per run and appends; this one can be repeated, so the previous
      // answer goes first rather than being doubled.
      this.deps.auditStore.clearRunAudit(trace.id);
      await this.identifyFor(chat, trace);
      await this.auditAll(chat);
      return;
    }
    await this.identifyFor(chat, trace);
    // Asking again answers the same questions again, at both levels.
    this.deps.auditStore.clearSpanAudits(trace.id);
    this.deps.auditStore.clearRunAudit(trace.id);

    // A snapshot, taken once. Anything appended while this runs belongs to the
    // next audit of this trace, not to this one.
    //
    // The model calls only: a trace also carries the run and prompt spans the
    // pipeline opens it with, and those are not steps the auditor took.
    const auditorSpans = trace.spans.filter(
      (span) => span.kind === "model_call",
    );

    // Judged one at a time, each attributed to the step it is about — the same
    // shape the automatic pass produces for an Agent's steps. Judging the trace
    // as a whole and nothing else made an auditor's entire run read as a single
    // step, however much work it had done.
    const budget = auditorSpans.slice(
      0,
      this.deps.requestedStepBudget ?? MAX_REQUESTED_STEP_AUDITS,
    );
    const unjudged = auditorSpans.length - budget.length;
    for (const span of budget) {
      chat.openStep();
      this.enqueue(() =>
        this.auditorStepAudit(chat, trace, span).finally(() =>
          chat.closeStep(),
        ),
      );
    }

    await this.batch.queue(async () => {
      // The run-level pass reads every step, so it must not start while the
      // step audits are still in flight — the same ordering the Agent-level
      // run audit keeps for the same reason.
      await chat.awaitSteps();
      const { steps, status } = await this.auditorFindings(
        trace,
        auditorSpans,
        unjudged,
      );
      this.deps.auditStore.recordRequestedAudit(
        trace,
        steps,
        "",
        healthOf(status),
      );
      this.closeAuditTrace(chat);
    });
  }

  // One step of an auditor's run, judged on its own. Deterministic first, so a
  // failed call or a leaked credential is still reported when the audit model
  // is unreachable; the model is asked only where there is a verdict to weigh.
  private async auditorStepAudit(
    chat: AgentChatAuditor,
    trace: TraceRecord,
    span: TraceSpan,
  ) {
    const identity = {
      id: randomUUID(),
      traceId: trace.id,
      agentId: trace.agentId,
      spanId: span.id,
    };
    // The auditor's prompt embeds step content. Redaction runs before a span is
    // stored, so a credential surfacing here means masking missed it on the way
    // into the auditor — worth knowing, and not something a model should judge.
    const seen =
      readAttribute(span, "context") + "\n" + readAttribute(span, "output");
    const leaked = detectSecretBindings(seen).length > 0;

    // A call that failed returned no verdict, so there is nothing to weigh and
    // no reason to spend a model on it.
    if (readAttribute(span, "output").length === 0) {
      const steps = auditSteps(identity, (push) => {
        push(
          "warning",
          "audit-health",
          "This auditor step produced no verdict: " +
            (span.error ?? "no output was recorded"),
        );
        if (leaked) push("warning", "security", leakedCredentialFinding(span));
      });
      this.deps.auditStore.recordSpan(trace, span.id, steps, "", "degraded");
      return;
    }

    const { verdict, status, failure } = await this.stepCheck(trace, span.id, {
      name: "audit.auditor.step",
      label: "Auditor step · " + span.label,
      system: META_STEP_SYSTEM_PROMPT,
      user: buildAuditorStepContext(trace, span),
      schema: metaVerdict,
    });

    const steps = auditSteps(identity, (push) => {
      if (leaked) push("warning", "security", leakedCredentialFinding(span));
      for (const entry of verdict?.unsupportedFindings ?? []) {
        push("warning", "audit-health", "Unsupported finding: " + entry);
      }
      for (const entry of verdict?.missedSignals ?? []) {
        push("suspicion", "audit-health", "Possibly missed: " + entry);
      }
      pushAuditorStatus(push, status, failure);
    });
    this.deps.auditStore.recordSpan(
      trace,
      span.id,
      steps,
      "",
      healthOf(status),
    );
  }

  private async auditorFindings(
    trace: TraceRecord,
    auditorSpans: TraceSpan[],
    // Steps the requested-audit budget stopped this pass from judging.
    // Reported here so a repeated audit cannot drop the notice and read as
    // though it had looked at everything.
    unjudged = 0,
  ) {
    const identity = {
      id: randomUUID(),
      traceId: trace.id,
      agentId: trace.agentId,
      spanId: null,
    };
    if (auditorSpans.length === 0) {
      const steps = auditSteps(identity, (push) =>
        push(
          "warning",
          "audit-health",
          "This run has no auditor steps recorded, so there is nothing to " +
            "check. Either the run was never audited, or auditing was disabled " +
            "while it ran.",
        ),
      );
      return { steps, status: "completed" as const };
    }

    // Failed steps and leaked credentials are reported by the per-step pass,
    // which can name the step each belongs to. What is left for this one is the
    // question no single step can answer: what the auditor missed across all of
    // them.
    const prompt = buildMetaContext(trace, auditorSpans);
    const { verdict, status, failure, attempts } = await this.model.complete(
      this.auditorRun(trace),
      this.deps.securityModel,
      this.deps.intentModel !== this.deps.securityModel
        ? this.deps.intentModel
        : null,
      META_SYSTEM_PROMPT,
      prompt,
      metaVerdict,
    );
    // The pass that judges an auditor leaves its own record, exactly as the
    // pass that judges an Agent does. Without this an audit of an audit would
    // produce findings out of nothing an audit above it could read, and the
    // stack would stop dead at this level.
    this.recordAuditorAttempts(trace, {
      name: "audit.auditor",
      // The pass over the auditor's whole trace, sitting beneath the per-step
      // rows rather than standing in for them.
      label: "Auditor run audit",
      targetSpanId: null,
      prompt,
      attempts,
      usedFallback: status === "degraded",
    });

    const steps = auditSteps(identity, (push) => {
      if (unjudged > 0) {
        push(
          "warning",
          "audit-health",
          "The step budget stopped this audit after " +
            (auditorSpans.length - unjudged) +
            " of " +
            auditorSpans.length +
            " auditor steps, so " +
            unjudged +
            " went unexamined.",
        );
      }
      for (const entry of verdict?.unsupportedFindings ?? []) {
        push("warning", "audit-health", "Unsupported finding: " + entry);
      }
      for (const entry of verdict?.missedSignals ?? []) {
        push("suspicion", "audit-health", "Possibly missed: " + entry);
      }
      pushAuditorStatus(push, status, failure);
    });
    return { steps, status };
  }
}
