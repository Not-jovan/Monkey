import { expect, type APIRequestContext } from "@playwright/test";

export interface Agent {
  id: string;
  name: string;
  workspacePath: string;
  codexThreadId: string | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error: string | null;
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
  prompt: string;
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
  type: "warning" | "error";
  category: "intent-check" | "security";
  finding: string;
}

export interface TraceDetail {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  auditComplete: boolean;
}

export interface IntentUpdate {
  id: string;
  message: string;
  added: string[];
  objectiveAfter: string | null;
  status: "applied" | "pending" | "rejected";
}

export interface IntentResponse {
  intent: { objective: string; extended: string[] };
  pending: IntentUpdate[];
  history: IntentUpdate[];
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

export async function getIntent(
  request: APIRequestContext,
  agentId: string,
): Promise<IntentResponse> {
  return json<IntentResponse>(
    await request.get(`/api/agents/${agentId}/intent`),
  );
}
