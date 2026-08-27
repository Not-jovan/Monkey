import type {
  Agent,
  AgentLifecycleEvent,
  AgentRun,
  AuditTraceStep,
  IntentChatRef,
  IntentSnapshot,
  IntentState,
  IntentUpdate,
  Message,
  SystemInfo,
  TraceRecord,
  TraceSummary,
} from "./types";

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
    request<{ traces: TraceSummary[]; lifecycle: AgentLifecycleEvent[] }>(
      "/api/agents/" + id + "/traces",
    ),
  trace: (id: string) =>
    request<{
      trace: TraceRecord;
      findings: AuditTraceStep[];
      auditComplete: boolean;
    }>("/api/traces/" + id),
  intent: (id: string) =>
    request<{
      intent: IntentState;
      lastModifiedBy: IntentChatRef | null;
      pending: IntentUpdate[];
      history: IntentUpdate[];
      states: IntentSnapshot[];
      requiresConfirmation: boolean;
      updatedAt: string | null;
    }>("/api/agents/" + id + "/intent"),
  resolveIntent: (
    id: string,
    updateId: string,
    decision: "confirm" | "reject",
  ) =>
    request<{ intent: IntentState; pending: IntentUpdate[] }>(
      "/api/agents/" + id + "/intent/" + updateId,
      { method: "POST", body: JSON.stringify({ decision }) },
    ),
  downloadTrace: (id: string) =>
    request<{
      exportedAt: string;
      trace: TraceRecord;
      findings: AuditTraceStep[];
      auditComplete: boolean;
    }>("/api/traces/" + id + "/download"),
  exportTrace: (id: string) =>
    request<{
      exportedAt: string;
      trace: TraceRecord;
      findings: AuditTraceStep[];
      auditComplete: boolean;
    }>(
      "/api/traces/" + id + "/export",
    ),
};
