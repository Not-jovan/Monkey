import { blamesAgent, type FailureLayer, type Retryability } from "../../failures.js";
import type { AuditHealth, AuditTraceStep } from "../audit/audit-model.js";
import { activityFromSpan } from "../audit/step-activity.js";
import { isTrajectoryStep, summarizeTrajectory } from "../audit/step-context.js";
import type { ContextView } from "../context/context-service.js";
import type { IntentState } from "../intent/intent-model.js";
import { isAuditorTrace } from "./trace-model.js";
import type { TraceRecord, TraceSpan, TraceStatus } from "./trace-model.js";

// The human Glass Box dumps the record. These views are what a diagnosing
// agent should read instead: a triage index, a grouped failure list, and one
// case file per run. Raw spans stay on /api/traces/:id.

const LIST_PROMPT = 240;
const CASE_PROMPT = 2_000;
const CASE_EVIDENCE = 1_500;
const STEP_ARGS = 500;
const FAILING_OUTPUT = 2_000;
const CAUSED_BY_OUTPUT = 400;
const TRAJECTORY_LIMIT = 20;

export type AgentBlame = "agent" | "environment";

export interface AgentAnchor {
  spanId: string;
  label: string;
  kind: string;
}

export interface AgentDiagnosis {
  outcome: "failed" | "recovered";
  headline: string;
  layer: FailureLayer;
  blame: AgentBlame;
  kind: string;
  retryability: Retryability;
  remedy: string;
  where: AgentAnchor | null;
  causedBy: AgentAnchor | null;
  evidence: string;
  evidenceComplete: boolean;
}

export interface AgentTraceSummary {
  id: string;
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  model: string | null;
  spanCount: number;
  errorCount: number;
  recoveredErrorCount: number;
  evidenceComplete: boolean;
  warningCount: number;
  suspicionCount: number;
  auditHealth: AuditHealth;
  diagnosis: Omit<AgentDiagnosis, "evidence"> | null;
}

export interface AgentFailureGroup {
  kind: string;
  layer: string;
  retryability: string;
  title: string;
  remedy: string;
  blamesAgent: boolean;
  count: number;
  lastSeenAt: string;
  detail: string;
  traceIds: string[];
}

export interface AgentStep {
  id: string;
  kind: string;
  name: string;
  label: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  arguments: string | null;
  output: string | null;
  commands: string[];
  files: string[];
}

export interface AgentFinding {
  type: AuditTraceStep["type"];
  category: AuditTraceStep["category"];
  finding: string;
  span: AgentAnchor | null;
}

export interface AgentTraceCase {
  id: string;
  agentId: string;
  status: TraceStatus;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  prompt: string;
  usage: TraceRecord["usage"];
  evidenceComplete: boolean;
  recoveredErrorCount: number;
  diagnosis: AgentDiagnosis | null;
  intent: IntentState | null;
  context: {
    position: number;
    chainLength: number;
    previousTraceId: string | null;
    nextTraceId: string | null;
    carriedIn: string | null;
  } | null;
  findings: AgentFinding[];
  trajectory: string[];
  trajectoryTruncated: number;
  failingStep: AgentStep | null;
  causedByStep: AgentStep | null;
  auditComplete: boolean;
  auditHealth: AuditHealth;
  auditTraceId: string | null;
  auditAttempts: {
    id: string;
    status: TraceStatus;
    startedAt: string;
    endedAt: string | null;
  }[];
  auditChain: { id: string; auditDepth: number; status: TraceStatus }[];
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + " …[truncated " + (text.length - limit) + " chars]";
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

function errorCountOf(trace: TraceRecord): number {
  let count = 0;
  for (const span of trace.spans) {
    if (span.status === "error") count += 1;
  }
  return count;
}

function anchor(span: TraceSpan | undefined): AgentAnchor | null {
  if (!span) return null;
  return { spanId: span.id, label: span.label, kind: span.kind };
}

function evidenceFor(span: TraceSpan | undefined, trace: TraceRecord): string {
  const output = span?.attributes.output;
  if (typeof output === "string" && output.length > 0) return output;
  if (span?.error) return span.error;
  return trace.failure?.detail ?? "";
}

function blameOf(layer: FailureLayer): AgentBlame {
  return blamesAgent({ layer }) ? "agent" : "environment";
}

export function agentDiagnosis(trace: TraceRecord): AgentDiagnosis | null {
  const runStopped = trace.status === "failed" || trace.status === "cancelled";
  const failing = trace.spans.find((span) => span.id === trace.failingSpanId);
  const failure = trace.failure;
  // A completed run with a classified failure (the agent recovered) is still
  // something to diagnose. Only a clean run has nothing to say.
  if (!runStopped && !failing && !failure) return null;

  const layer: FailureLayer = failure?.layer ?? "platform";
  const causedBySpanId = failing?.attributes.causedBySpanId;
  return {
    outcome: runStopped ? "failed" : "recovered",
    headline:
      failure?.title ??
      (runStopped ? "The run failed" : "A step failed during this run"),
    layer,
    blame: blameOf(layer),
    kind: failure?.kind ?? "unknown",
    retryability: failure?.retryability ?? "transient",
    remedy:
      failure?.remedy ??
      "Open the failing step and read its output for the cause.",
    where: anchor(failing),
    causedBy:
      typeof causedBySpanId === "string"
        ? anchor(trace.spans.find((span) => span.id === causedBySpanId))
        : null,
    evidence: clip(evidenceFor(failing, trace), CASE_EVIDENCE),
    evidenceComplete: trace.evidenceComplete,
  };
}

function compactStep(
  span: TraceSpan | undefined,
  trace: TraceRecord,
  outputLimit: number,
): AgentStep | null {
  if (!span) return null;
  const activity = activityFromSpan(span, trace);
  const args = span.attributes.arguments;
  const output = span.attributes.output;
  return {
    id: span.id,
    kind: span.kind,
    name: span.name,
    label: span.label,
    status: span.status,
    durationMs: span.durationMs,
    error: span.error,
    arguments:
      typeof args === "string" && args.length > 0
        ? clip(args, STEP_ARGS)
        : null,
    output:
      typeof output === "string" && output.length > 0
        ? clip(output, outputLimit)
        : null,
    commands: activity.commands,
    files: [...new Set(activity.files.map((file) => file.path))],
  };
}

export function agentTraceSummary(input: {
  trace: TraceRecord;
  warningCount: number;
  suspicionCount: number;
  auditHealth: AuditHealth;
}): AgentTraceSummary {
  const diagnosis = agentDiagnosis(input.trace);
  return {
    id: input.trace.id,
    status: input.trace.status,
    startedAt: input.trace.startedAt,
    endedAt: input.trace.endedAt,
    prompt: oneLine(input.trace.prompt, LIST_PROMPT),
    model: input.trace.model,
    spanCount: input.trace.spans.length,
    errorCount: errorCountOf(input.trace),
    recoveredErrorCount: input.trace.recoveredErrorCount,
    evidenceComplete: input.trace.evidenceComplete,
    warningCount: input.warningCount,
    suspicionCount: input.suspicionCount,
    auditHealth: input.auditHealth,
    diagnosis: diagnosis
      ? {
          outcome: diagnosis.outcome,
          headline: diagnosis.headline,
          layer: diagnosis.layer,
          blame: diagnosis.blame,
          kind: diagnosis.kind,
          retryability: diagnosis.retryability,
          remedy: diagnosis.remedy,
          where: diagnosis.where,
          causedBy: diagnosis.causedBy,
          evidenceComplete: diagnosis.evidenceComplete,
        }
      : null,
  };
}

export function agentFailureGroups(traces: TraceRecord[]): AgentFailureGroup[] {
  const groups = new Map<string, AgentFailureGroup>();
  for (const trace of traces) {
    if (isAuditorTrace(trace)) continue;
    const failure = trace.failure;
    if (!failure) continue;
    const existing = groups.get(failure.kind);
    if (existing) {
      existing.count += 1;
      existing.traceIds.push(trace.id);
      continue;
    }
    groups.set(failure.kind, {
      kind: failure.kind,
      layer: failure.layer,
      retryability: failure.retryability,
      title: failure.title,
      remedy: failure.remedy,
      blamesAgent: blamesAgent(failure),
      count: 1,
      lastSeenAt: trace.endedAt ?? trace.startedAt,
      detail: failure.detail,
      traceIds: [trace.id],
    });
  }
  return [...groups.values()].sort((left, right) => {
    const leftBlame = left.blamesAgent ? 1 : 0;
    const rightBlame = right.blamesAgent ? 1 : 0;
    if (leftBlame !== rightBlame) return rightBlame - leftBlame;
    return right.count - left.count;
  });
}

export function agentTraceCase(input: {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  auditComplete: boolean;
  auditHealth: AuditHealth;
  intent: IntentState | null;
  context: ContextView | null;
  auditTraceId: string | null;
  auditAttempts: {
    id: string;
    status: TraceStatus;
    startedAt: string;
    endedAt: string | null;
  }[];
  auditChain: { id: string; auditDepth: number; status: TraceStatus }[];
}): AgentTraceCase {
  const { trace } = input;
  const diagnosis = agentDiagnosis(trace);
  const failing = trace.spans.find((span) => span.id === trace.failingSpanId);
  const causedBySpanId = failing?.attributes.causedBySpanId;
  const causedBy =
    typeof causedBySpanId === "string"
      ? trace.spans.find((span) => span.id === causedBySpanId)
      : undefined;
  const trajectorySteps = trace.spans.filter(isTrajectoryStep);
  const trajectory = summarizeTrajectory(trace, { limit: TRAJECTORY_LIMIT });
  const spanById = new Map(trace.spans.map((span) => [span.id, span]));

  return {
    id: trace.id,
    agentId: trace.agentId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    model: trace.model,
    prompt: clip(trace.prompt, CASE_PROMPT),
    usage: trace.usage,
    evidenceComplete: trace.evidenceComplete,
    recoveredErrorCount: trace.recoveredErrorCount,
    diagnosis,
    intent: input.intent,
    context: input.context
      ? {
          position: input.context.position,
          chainLength: input.context.chainLength,
          previousTraceId: input.context.previousTraceId,
          nextTraceId: input.context.nextTraceId,
          carriedIn: input.context.carriedIn?.summary ?? null,
        }
      : null,
    findings: input.findings.map((finding) => ({
      type: finding.type,
      category: finding.category,
      finding: finding.finding,
      span: finding.spanId ? anchor(spanById.get(finding.spanId)) : null,
    })),
    trajectory,
    trajectoryTruncated: Math.max(0, trajectorySteps.length - trajectory.length),
    failingStep: compactStep(failing, trace, FAILING_OUTPUT),
    causedByStep: compactStep(causedBy, trace, CAUSED_BY_OUTPUT),
    auditComplete: input.auditComplete,
    auditHealth: input.auditHealth,
    auditTraceId: input.auditTraceId,
    auditAttempts: input.auditAttempts,
    auditChain: input.auditChain,
  };
}

export function filterAgentSummaries(
  traces: AgentTraceSummary[],
  query: { blame?: AgentBlame | undefined; status?: TraceStatus | undefined },
): AgentTraceSummary[] {
  return traces.filter((trace) => {
    if (query.status && trace.status !== query.status) return false;
    if (query.blame) {
      if (trace.diagnosis === null) return false;
      if (trace.diagnosis.blame !== query.blame) return false;
    }
    return true;
  });
}
