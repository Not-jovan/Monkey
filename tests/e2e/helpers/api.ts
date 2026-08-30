import { expect, type APIRequestContext } from "@playwright/test";

export interface Agent {
  id: string;
  name: string;
  workspacePath: string;
  codexThreadId: string | null;
}

export type FailureLayer =
  | "platform"
  | "provider"
  | "policy"
  | "agent"
  | "task"
  | "user";

export interface RunFailure {
  layer: FailureLayer;
  kind: string;
  retryability: "transient" | "permanent" | "user-action";
  title: string;
  detail: string;
  remedy: string;
  exitCode: number | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  failure: RunFailure | null;
}

export interface TraceSpan {
  id: string;
  name: string;
  kind: "run" | "user_action" | "turn" | "model_call" | "tool_call" | "system";
  status: "running" | "ok" | "error";
  attributes: Record<string, string | number | boolean>;
}

export interface TraceRecord {
  id: string;
  agentId: string;
  conversationId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  auditOf: string | null;
  auditDepth: number;
  prompt: string;
  failingSpanId: string | null;
  failure: RunFailure | null;
  recoveredErrorCount: number;
  evidenceComplete: boolean;
  usage: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
  };
  spans: TraceSpan[];
}

export interface AuditTraceStep {
  id: string;
  traceId: string;
  agentId: string;
  spanId: string | null;
  intentId: string;
  type: "warning" | "suspicion" | "error";
  category: "intent-check" | "security" | "reliability" | "audit-health";
  finding: string;
}

export interface RunContext {
  traceId: string;
  summary: string;
  source: "derived" | "model";
}

export interface ContextView {
  carriedIn: RunContext | null;
  carriedOut: RunContext | null;
  position: number;
  chainLength: number;
  previousTraceId: string | null;
  nextTraceId: string | null;
}

export interface TraceDetail {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  auditComplete: boolean;
  auditHealth: "ok" | "degraded" | "failed";
  intent: {
    instructions: string;
    objective: string;
    extended: string[];
  } | null;
  context: ContextView | null;
  auditTraceId: string | null;
  auditChain: { id: string; auditDepth: number }[];
}

export interface IntentUpdate {
  logs: string[];
  kind: "seed" | "classified";
  message?: string;
  reason?: string;
  addedConstraints: string[];
  previousObjective: string | null;
  traceId: string | null;
  revertedFrom: string | null;
}

export interface IntentVersionEntry {
  id: string;
  objective: string;
  extended: string[];
  createdAt?: string;
  update?: IntentUpdate;
}

export interface IntentResponse {
  intent: { objective: string; extended: string[] };
  versions: IntentVersionEntry[];
  intentId: string | null;
}

export interface IntentCorrection {
  id: string;
  agentId: string;
  traceId: string;
  findingIds: string[];
  correction: string;
  instructionsBefore: string;
  createdAt: string;
  revertedAt: string | null;
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

export async function waitForRun(
  request: APIRequestContext,
  runId: string,
): Promise<AgentRun> {
  let latest: AgentRun | null = null;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/runs/${runId}`);
        if (!response.ok()) return `http-${response.status()}`;
        latest = ((await response.json()) as { run: AgentRun }).run;
        return latest.status;
      },
      { timeout: 12 * 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toMatch(/^(completed|failed|cancelled)$/);
  expect(latest, "run response should be captured").not.toBeNull();
  return latest!;
}

export async function waitForAuditedTrace(
  request: APIRequestContext,
  traceId: string,
): Promise<TraceDetail> {
  let latest: TraceDetail | null = null;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/traces/${traceId}`);
        if (!response.ok()) return `http-${response.status()}`;
        latest = (await response.json()) as TraceDetail;
        const terminal = latest.trace.status !== "running";
        return terminal && latest.auditComplete ? "ready" : "pending";
      },
      { timeout: 12 * 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe("ready");
  return latest!;
}

export async function getAgent(
  request: APIRequestContext,
  agentId: string,
): Promise<Agent> {
  const response = await request.get(`/api/agents/${agentId}`);
  return (await json<{ agent: Agent }>(response)).agent;
}

// A failed run never produces a run-level audit summary the way a clean one
// does, so waiting on auditComplete would hang. The trace reaching a terminal
// state is the signal that matters here.
export async function waitForTrace(
  request: APIRequestContext,
  traceId: string,
): Promise<TraceDetail> {
  let latest: TraceDetail | null = null;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/traces/${traceId}`);
        if (!response.ok()) return `http-${response.status()}`;
        latest = (await response.json()) as TraceDetail;
        return latest.trace.status;
      },
      { timeout: 12 * 60_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toMatch(/^(completed|failed|cancelled)$/);
  return latest!;
}

export async function getIntent(
  request: APIRequestContext,
  agentId: string,
): Promise<IntentResponse> {
  return json<IntentResponse>(
    await request.get(`/api/agents/${agentId}/intent`),
  );
}

export async function corrections(
  request: APIRequestContext,
  agentId: string,
): Promise<IntentCorrection[]> {
  return (
    await json<{ corrections: IntentCorrection[] }>(
      await request.get(`/api/agents/${agentId}/corrections`),
    )
  ).corrections;
}

export async function correctIntent(
  request: APIRequestContext,
  traceId: string,
  findingIds: string[],
  correction: string,
): Promise<IntentCorrection> {
  return (
    await json<{ correction: IntentCorrection }>(
      await request.post(`/api/traces/${traceId}/intent/correct`, {
        data: { findingIds, correction },
      }),
    )
  ).correction;
}

export async function auditTrace(
  request: APIRequestContext,
  traceId: string,
): Promise<{ traceId: string; auditTraceId: string | null }> {
  return json<{ traceId: string; auditTraceId: string | null }>(
    await request.post(`/api/traces/${traceId}/audit`),
  );
}
