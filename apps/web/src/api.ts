import type {
  Agent,
  AgentRun,
  AuditHealth,
  AuditorTrace,
  AuditTraceStep,
  ContextView,
  IntentState,
  IntentVersionEntry,
  Message,
  RunFailure,
  SystemInfo,
  TraceIntentView,
  TraceRecord,
  TraceSummary,
} from "./types";

export interface TraceDetail {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  auditComplete: boolean;
  auditHealth: AuditHealth;
  intentId: string | null;
  intent: TraceIntentView | null;
  context: ContextView | null;
}

export interface IntentView {
  intent: IntentState;
  versions: IntentVersionEntry[];
  intentId: string | null;
}

export interface FailureGroup {
  kind: string;
  layer: string;
  retryability: string;
  title: string;
  remedy: string;
  count: number;
  lastSeenAt: string;
  traceIds: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Structural rather than `instanceof`: react-query re-wraps and clones rejected
// values, so prototype identity is not reliable by the time a component reads
// `query.error`.
export function isApiErrorWithStatus(error: unknown, status: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === status
  );
}

// Deliberately in-memory only: the operator token must never reach browser
// storage. Client-side routing keeps it across the Playground/Traces pages; a
// hard reload asks for it again.
let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function hasAuthToken(): boolean {
  return authToken.length > 0;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  agentTraces: (id: string) =>
    request<{ traces: TraceSummary[] }>("/api/agents/" + id + "/traces"),
  trace: (id: string) => request<TraceDetail>("/api/traces/" + id),
  agentFailures: (id: string) =>
    request<{ failures: FailureGroup[] }>("/api/agents/" + id + "/failures"),
  intent: (id: string) => request<IntentView>("/api/agents/" + id + "/intent"),
  // Appends a version restoring an earlier one; it never rewinds history, so a
  // trace that pinned the reverted version still resolves.
  revertIntent: (id: string, intentId: string) =>
    request<IntentView>("/api/agents/" + id + "/intent/revert", {
      method: "POST",
      body: JSON.stringify({ intentId }),
    }),
  downloadTrace: (id: string) =>
    request<TraceDetail & { exportedAt: string }>(
      "/api/traces/" + id + "/download",
    ),
  auditor: (id: string) => request<AuditorTrace>("/api/audits/" + id),
};

export type { RunFailure };
