import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  api,
  hasAuthToken,
  isApiErrorWithStatus,
  type TraceDetail,
} from "../api";
import type { TraceRecord } from "../types";
import { TraceRunView, type StepView } from "./TraceRunView";

type TracePane = "run" | "auditor";

function download(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function openJson(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  // A blob URL lives on this document. Opening with noopener detaches the
  // tab from that store, and Chromium then shows a dead blob: address.
  // Revoking after a timeout does the same if they refresh or keep the tab.
  const opened = window.open(url, "_blank");
  if (!opened) {
    download(fileName, data);
    URL.revokeObjectURL(url);
    return;
  }
  opened.addEventListener("unload", () => URL.revokeObjectURL(url));
}

function readStoredView(): StepView {
  try {
    const stored = localStorage.getItem("trace-view");
    if (stored === "list" || stored === "timeline") return stored;
    if (stored === "graph" || stored === "flow") return "graph";
  } catch {
    // Private windows and blocked site data throw on access.
  }
  return "graph";
}

function persistView(view: StepView) {
  try {
    localStorage.setItem("trace-view", view);
  } catch {
    // Remembering the choice is a convenience, never a requirement.
  }
}

function readStoredPane(): TracePane {
  try {
    if (localStorage.getItem("trace-pane") === "auditor") return "auditor";
  } catch {
    // Same as the step-view preference.
  }
  return "run";
}

function persistPane(pane: TracePane) {
  try {
    localStorage.setItem("trace-pane", pane);
  } catch {
    // Remembering the choice is a convenience, never a requirement.
  }
}

// Where this trace sits in the stack of audits above the Agent run at the root
// of it. Rendered only once there is a stack: a run nobody has audited has a
// chain of one, and saying so would be noise.
//
// There is no ceiling here on purpose. However deep someone has chosen to go,
// the way back is the same list.
function AuditChain({
  chain,
  current,
}: {
  chain: { id: string; auditDepth: number }[];
  current: string;
}) {
  if (chain.length < 2) return null;
  return (
    <nav className="audit-chain" aria-label="Audit chain">
      {chain.map((entry, index) => (
        <span key={entry.id}>
          {index > 0 && <span className="audit-chain-separator"> › </span>}
          {entry.id === current ? (
            <span className="audit-chain-current" aria-current="page">
              {auditChainLabel(entry.auditDepth)}
            </span>
          ) : (
            <Link to={"/traces/" + entry.id}>
              {auditChainLabel(entry.auditDepth)}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

// One entry per level, all named the same. The position in the chain already
// says how deep it is, and numbering them made a stack read as a single
// summarised hop rather than as the sequence of audits it is.
export function auditChainLabel(depth: number) {
  return depth === 0 ? "Agent run" : "Audit";
}

function tracePollMs(data: TraceDetail | undefined) {
  if (!data) return 4_000;
  if (data.trace.status === "running") return 1_200;
  // Agent runs are judged automatically; keep polling until that pass lands.
  // An auditor is judged only when asked, so incompleteness is the steady state.
  if (data.trace.auditOf === null && data.auditComplete === false) return 1_200;
  return 4_000;
}

export function TraceDetailPage() {
  const { traceId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [runSpanId, setRunSpanId] = useState<string | null>(null);
  const [auditorSpanId, setAuditorSpanId] = useState<string | null>(null);
  const [view, setView] = useState<StepView>(readStoredView);
  const [pane, setPane] = useState<TracePane>(() =>
    searchParams.get("pane") === "auditor"
      ? "auditor"
      : searchParams.get("pane") === "run"
        ? "run"
        : searchParams.get("finding")
          ? "run"
          : readStoredPane(),
  );
  const focusedFindingId = searchParams.get("finding");

  const authQuery = useQuery({ queryKey: ["auth"], queryFn: api.auth });
  const locked = authQuery.data?.required === true && !hasAuthToken();

  const detailQuery = useQuery({
    queryKey: ["trace", traceId],
    queryFn: (): Promise<TraceDetail> => api.trace(traceId),
    enabled: !locked && traceId.length > 0,
    refetchInterval: (query: { state: { data: TraceDetail | undefined } }) =>
      tracePollMs(query.state.data),
  });

  const auditTraceId = detailQuery.data?.auditTraceId ?? null;
  const auditorDetailQuery = useQuery({
    queryKey: ["trace", auditTraceId],
    queryFn: (): Promise<TraceDetail> => api.trace(auditTraceId!),
    enabled: !locked && auditTraceId !== null,
    refetchInterval: (query: { state: { data: TraceDetail | undefined } }) =>
      tracePollMs(query.state.data),
  });

  const trace: TraceRecord | null = detailQuery.data?.trace ?? null;
  const auditHealth = detailQuery.data?.auditHealth ?? "ok";

  const chooseView = (next: StepView) => {
    setView(next);
    persistView(next);
  };

  const choosePane = (next: TracePane) => {
    setPane(next);
    persistPane(next);
  };

  if (locked || detailQuery.error) {
    let message = "Could not load the trace.";
    if (isApiErrorWithStatus(detailQuery.error, 404)) {
      message = "This trace does not exist (yet).";
    }
    if (locked || isApiErrorWithStatus(detailQuery.error, 401)) {
      message = "Unlock the launchpad from the Playground first.";
    }
    return (
      <div className="glassbox-page">
        <div className="error-banner" role="alert">
          <span>{message}</span>
        </div>
        <Link className="button button-ghost" to="/traces">
          ← Back
        </Link>
      </div>
    );
  }

  return (
    <div className="glassbox-page">
      <header className="glassbox-topbar">
        <Link className="button button-ghost" to="/traces">
          ← Back
        </Link>
        <div className="glassbox-topbar-actions">
          <button
            className="button button-ghost"
            disabled={!trace}
            onClick={async () => {
              const payload = await api.trace(traceId);
              openJson("trace-" + traceId + "-api.json", payload);
            }}
          >
            Trace API
          </button>
          <button
            className="button button-ghost"
            disabled={!trace}
            onClick={async () => {
              const payload = await api.auditor(traceId);
              openJson("audit-" + traceId + "-api.json", payload);
            }}
          >
            Auditor API
          </button>
          <button
            className="button button-ghost"
            disabled={!trace}
            onClick={async () => {
              const payload = await api.downloadTrace(traceId);
              download("trace-" + traceId + ".json", payload);
            }}
          >
            Download
          </button>
        </div>
      </header>

      {trace && (
        <>
          <AuditChain chain={detailQuery.data?.auditChain ?? []} current={traceId} />
          <div className="pane-toggle view-toggle" role="tablist" aria-label="Trace view">
            <button
              type="button"
              role="tab"
              className={pane === "run" ? "is-active" : ""}
              aria-selected={pane === "run"}
              onClick={() => choosePane("run")}
            >
              View Run
            </button>
            <button
              type="button"
              role="tab"
              className={pane === "auditor" ? "is-active" : ""}
              aria-selected={pane === "auditor"}
              onClick={() => choosePane("auditor")}
            >
              View Auditor
              {auditHealth !== "ok" && (
                <span className="pane-mark">issue</span>
              )}
            </button>
          </div>
        </>
      )}

      {pane === "run" && detailQuery.data && (
        <TraceRunView
          detail={detailQuery.data}
          view={view}
          onViewChange={chooseView}
          selectedSpanId={runSpanId}
          onSelectSpan={setRunSpanId}
          focusedFindingId={focusedFindingId}
        />
      )}

      {pane === "auditor" && auditorDetailQuery.data && (
        <TraceRunView
          detail={auditorDetailQuery.data}
          view={view}
          onViewChange={chooseView}
          selectedSpanId={auditorSpanId}
          onSelectSpan={setAuditorSpanId}
          focusedFindingId={focusedFindingId}
        />
      )}

      {pane === "auditor" &&
        !auditorDetailQuery.data &&
        (!auditTraceId || auditorDetailQuery.error) && (
          <p className="muted-cell">
            The auditor has not recorded any steps yet.
          </p>
        )}
    </div>
  );
}
