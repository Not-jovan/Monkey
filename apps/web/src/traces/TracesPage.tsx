import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, hasAuthToken, isApiErrorWithStatus } from "../api";
import type { Agent, TraceSummary } from "../types";
import { LAYER_COPY } from "./failure";
import { formatDateTime, formatDuration, spanDuration } from "./format";

const columnHelper = createColumnHelper<TraceSummary>();

const columns = [
  columnHelper.accessor("startedAt", {
    header: "Started",
    cell: (info) => formatDateTime(info.getValue()),
  }),
  columnHelper.accessor("prompt", {
    header: "Prompt",
    cell: (info) => {
      const value = info.getValue();
      return value.length > 64 ? value.slice(0, 64) + "…" : value;
    },
  }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => (
      <span className={"trace-status trace-status-" + info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  // Why it failed, at list level. Scanning for a pattern across runs is what
  // turns a single incident into something worth fixing, and that was
  // impossible when every failed row said only "failed".
  columnHelper.display({
    id: "failure",
    header: "Cause",
    cell: ({ row }) => {
      const failure = row.original.failure;
      if (!failure) {
        return row.original.recoveredErrorCount > 0 ? (
          <span
            className="recovered-badge"
            title="Succeeded, but only after recovering from errors"
          >
            ↺ {row.original.recoveredErrorCount}
          </span>
        ) : (
          <span className="muted-cell">—</span>
        );
      }
      const copy = LAYER_COPY[failure.layer];
      // A completed run can still carry attribution: the step broke and the
      // agent worked around it. Marked, because a clean-looking row that
      // absorbed a denial is the easiest problem to scroll past.
      const recovered = row.original.status === "completed";
      return (
        <span
          className={"failure-chip failure-blame-" + copy.blame}
          title={
            (recovered ? "Recovered: " : "") + copy.note + " " + failure.title
          }
        >
          {recovered ? "↺ " : ""}
          {copy.label} · {failure.kind}
        </span>
      );
    },
  }),
  columnHelper.display({
    id: "duration",
    header: "Duration",
    cell: ({ row }) =>
      formatDuration(spanDuration(row.original.startedAt, row.original.endedAt)),
  }),
  columnHelper.display({
    id: "tokens",
    header: "Tokens in/out",
    cell: ({ row }) =>
      row.original.usage.inputTokens + " / " + row.original.usage.outputTokens,
  }),
  columnHelper.accessor("spanCount", { header: "Steps" }),
  columnHelper.accessor("warningCount", {
    header: "Warnings",
    cell: ({ row }) => {
      const count = row.original.warningCount;
      const suspicions = row.original.suspicionCount;
      const health = row.original.auditHealth;
      return (
        <>
          {count > 0 ? (
            <span className="warning-badge">⚠ {count}</span>
          ) : suspicions === 0 ? (
            <span className="muted-cell">—</span>
          ) : null}
          {/* Muted, and never folded into the count beside it: a suspicion is
              a question the auditor could not settle, not a finding against
              the agent. Shown all the same, because an auditor that hides what
              it could not resolve is worse than one that over-reports. */}
          {suspicions > 0 && (
            <span
              className="suspicion-badge"
              title="Unresolved questions — open the trace to read them"
            >
              ? {suspicions}
            </span>
          )}
          {/* Kept visibly apart from the count: the auditor failing is a
              limitation of the middleware, never a claim about the agent. */}
          {health !== "ok" && (
            <span
              className="audit-health-badge"
              title="Open the trace and switch to View Auditor"
            >
              auditor
            </span>
          )}
        </>
      );
    },
  }),
];

export function TracesPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Determined up front rather than inferred from a failed data request: with
  // refetchInterval the error state is transient, so the banner would flicker.
  const authQuery = useQuery({ queryKey: ["auth"], queryFn: api.auth });
  const locked = authQuery.data?.required === true && !hasAuthToken();

  const agentsQuery = useQuery<{ agents: Agent[] }>({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    enabled: !locked,
    refetchInterval: 5_000,
  });
  const agents: Agent[] = agentsQuery.data?.agents ?? [];
  const selectedAgentId =
    searchParams.get("agent") ?? agents[0]?.id ?? "";

  const tracesQuery = useQuery({
    queryKey: ["traces", selectedAgentId],
    queryFn: () => api.agentTraces(selectedAgentId),
    enabled: !locked && selectedAgentId.length > 0,
    refetchInterval: 3_000,
  });
  const traces = tracesQuery.data?.traces ?? [];

  const table = useReactTable({
    data: traces,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  const authProblem =
    locked ||
    isApiErrorWithStatus(agentsQuery.error, 401) ||
    isApiErrorWithStatus(tracesQuery.error, 401);

  let emptyMessage = "Create an agent in the Playground to start tracing.";
  if (authProblem) {
    emptyMessage = "Traces are hidden until the launchpad is unlocked.";
  } else if (selectedAgentId) {
    emptyMessage =
      "No runs traced for this agent yet. Send a Playground message to create one.";
  }

  return (
    <div className="glassbox-page">
      <header className="glassbox-topbar">
        <div>
          <span className="eyebrow">Glass Box</span>
          <h1>Run traces</h1>
        </div>
        <div className="glassbox-topbar-actions">
          <select
            value={selectedAgentId}
            onChange={(event) => setSearchParams({ agent: event.target.value })}
          >
            {agents.length === 0 && <option value="">No agents yet</option>}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <Link className="button button-ghost" to="/">
            ← Playground
          </Link>
        </div>
      </header>

      {authProblem && (
        <div className="error-banner" role="alert">
          <span>
            This launchpad requires the access token. Unlock it from the
            Playground first, then come back to Traces.
          </span>
        </div>
      )}

      <section className="trace-table-card">
        <table className="trace-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => navigate("/traces/" + row.original.id)}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {traces.length === 0 && (
              <tr>
                <td className="trace-empty" colSpan={columns.length}>
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
