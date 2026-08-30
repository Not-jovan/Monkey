import type {
  Agent,
  AgentRun,
  AuditHealth,
  AuditorTrace,
  AuditTraceStep,
  ContextView,
  IntentCorrection,
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
  intent: TraceIntentView | null;
  context: ContextView | null;
  // The auditor that judged this trace, if it has been judged.
  auditTraceId: string | null;
  // Everything this trace is an audit of, up to the Agent run at the root of
  // it, oldest first. Resolved server-side because the chain has no ceiling and
  // the breadcrumb needs all of it at once.
  auditChain: { id: string; auditDepth: number }[];
}

export interface IntentView {
  intent: IntentState;
  // The objective has moved away from the agent's instructions and has not been
  // adopted into them. Derived server-side from the two values.
  diverged: boolean;
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
  downloadTrace: (id: string) =>
    request<TraceDetail & { exportedAt: string }>(
      "/api/traces/" + id + "/download",
    ),
  auditor: (id: string) => request<AuditorTrace>("/api/audits/" + id),
  // Audits any trace, whatever produced it: an Agent's run, or the run of the
  // auditor that judged it, however deep the stack goes. Manual by design — the
  // server audits depth 0 on its own and nothing else, ever.
  audit: (id: string) =>
    request<{ traceId: string; auditTraceId: string | null }>(
      "/api/traces/" + id + "/audit",
      { method: "POST" },
    ),
  auditArchiveUrl: (id: string) => "/api/audits/" + id + "/archive",
  // Turns findings into a constraint on the Agent. Several at once by design:
  // findings that share a cause read as one rule, not as near-duplicates.
  correctIntent: (traceId: string, findingIds: string[], correction: string) =>
    request<{ correction: IntentCorrection }>(
      "/api/traces/" + traceId + "/intent/correct",
      { method: "POST", body: JSON.stringify({ findingIds, correction }) },
    ),
  // Undo, and only for the newest correction still in force: what it restores
  // is the spec as it stood immediately before that one edit.
  revertCorrection: (agentId: string, correctionId: string) =>
    request<{ correction: IntentCorrection; instructions: string }>(
      "/api/agents/" + agentId + "/intent/revert",
      { method: "POST", body: JSON.stringify({ correctionId }) },
    ),
  corrections: (agentId: string) =>
    request<{ corrections: IntentCorrection[] }>(
      "/api/agents/" + agentId + "/corrections",
    ),
};

export type { RunFailure };
