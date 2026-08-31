import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  api,
  hasAuthToken,
  isApiErrorWithStatus,
  type TraceDetail,
} from "../api";
import type { AuditAttempt, TraceRecord } from "../types";
import {
  auditAction,
  auditInFlight,
  showFailedAlert,
  type TracePane,
} from "./audit-action";
import { attemptsOldestFirst, auditAttemptLabel } from "./audit-attempts";
import { debugPrompt } from "./debug-prompt";
import { TraceRunView, type StepView } from "./TraceRunView";

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
    if (stored === "list") return "list";
    if (stored === "timeline") return "timeline";
    if (stored === "events") return "events";
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

function AuditAttempts({
  attempts,
  selectedId,
  onSelect,
}: {
  attempts: AuditAttempt[];
  selectedId: string;
  onSelect: (id: string | null) => void;
}) {
  if (attempts.length < 2) return null;
  const latestId = attempts[0]?.id;
  return (
    <label className="audit-attempts-picker">
      <span className="audit-attempts-label">Attempts</span>
      <select
        aria-label="Auditor attempts"
        value={selectedId}
        onChange={(event) => {
          const id = event.target.value;
          onSelect(id === latestId ? null : id);
        }}
      >
        {attemptsOldestFirst(attempts).map((attempt, index) => (
          <option key={attempt.id} value={attempt.id}>
            {auditAttemptLabel({
              number: index + 1,
              latest: attempt.id === latestId,
              status: attempt.status,
            })}
          </option>
        ))}
      </select>
    </label>
  );
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
  const queryClient = useQueryClient();
  const [runSpanId, setRunSpanId] = useState<string | null>(null);
  const [auditorSpanId, setAuditorSpanId] = useState<string | null>(null);
  // null means follow the newest pass. Pinning an earlier one is how a retry
  // does not yank the reader off the attempt they were looking at.
  const [pinnedAttemptId, setPinnedAttemptId] = useState<string | null>(null);
  const [view, setView] = useState<StepView>(readStoredView);
  const [showDebugPrompt, setShowDebugPrompt] = useState(false);
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
  const systemQuery = useQuery({ queryKey: ["system"], queryFn: api.system });
  const locked = authQuery.data?.required === true && !hasAuthToken();

  const detailQuery = useQuery({
    queryKey: ["trace", traceId],
    queryFn: (): Promise<TraceDetail> => api.trace(traceId),
    enabled: !locked && traceId.length > 0,
    refetchInterval: (query: { state: { data: TraceDetail | undefined } }) =>
      tracePollMs(query.state.data),
  });

  const auditTraceId = detailQuery.data?.auditTraceId ?? null;
  const auditAttempts: AuditAttempt[] = detailQuery.data?.auditAttempts ?? [];
  const viewingAttemptId =
    pinnedAttemptId !== null &&
    auditAttempts.some((attempt) => attempt.id === pinnedAttemptId)
      ? pinnedAttemptId
      : auditTraceId;
  const auditorDetailQuery = useQuery({
    queryKey: ["trace", viewingAttemptId],
    queryFn: (): Promise<TraceDetail> => api.trace(viewingAttemptId!),
    enabled: !locked && viewingAttemptId !== null,
    refetchInterval: (query: { state: { data: TraceDetail | undefined } }) =>
      tracePollMs(query.state.data),
  });

  const trace: TraceRecord | null = detailQuery.data?.trace ?? null;
  const auditHealth = detailQuery.data?.auditHealth ?? "ok";

  // Offered on either tab: the auditor pane is a preview, so the trigger to
  // run (or retry) an audit has to live at page level or it vanishes the
  // moment you look at the pass you want to retry.
  const action = detailQuery.data
    ? auditAction({
        auditOf: detailQuery.data.trace.auditOf,
        status: detailQuery.data.trace.status,
        auditComplete: detailQuery.data.auditComplete,
        auditHealth: detailQuery.data.auditHealth,
        auditTraceId: detailQuery.data.auditTraceId,
      })
    : { view: null, run: false };

  // Requested rather than automatic, so the whole pass runs inside this call
  // and the button sits on "Auditing…" for as long as it takes. The refetch
  // that follows turns it into the way in to the audit it just wrote.
  const audit = useMutation({
    mutationFn: () => api.audit(traceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["trace", traceId] });
    },
  });

  const chooseView = (next: StepView) => {
    setView(next);
    persistView(next);
  };

  const choosePane = (next: TracePane) => {
    setPane(next);
    persistPane(next);
  };

  // Following the audit deeper changes only the id in the route, so the page
  // never unmounts and the tab would come along to a trace it does not
  // describe — landing on the audit of the audit instead of the run just
  // opened. Not choosePane: nobody picked this, so it must not overwrite the
  // tab they did pick.
  const followAudit = () => setPane("run");

  const auditBusy = audit.isPending || auditInFlight(auditAttempts);
  const canRetryAudit =
    pane === "auditor" &&
    auditAttempts.length > 0 &&
    detailQuery.data?.trace.status !== "running";
  const failed = showFailedAlert({ pane, auditHealth }) && !auditBusy;

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
      {systemQuery.data?.mockDisruptTracer && (
        <div className="error-banner" role="alert">
          <span>
            Tracer disruption mock is enabled. New runs still execute, but
            runtime event scraping will be interrupted intentionally.
          </span>
        </div>
      )}
      <header className="glassbox-topbar">
        <Link className="button button-ghost" to="/traces">
          ← Back
        </Link>
        <div className="glassbox-topbar-actions">
          <button
            className="button button-ghost"
            disabled={!trace}
            onClick={() => setShowDebugPrompt(true)}
          >
            Get Debug Prompt
          </button>
          <button
            className="button button-ghost"
            disabled={!trace}
            onClick={async () => {
              const payload = await api.auditor(traceId);
              openJson("audit-" + traceId + "-api.json", payload);
            }}
          >
            Auditor Trace
          </button>
          <button
            className="button button-ghost"
            disabled={!trace}
            onClick={async () => {
              const payload = await api.trace(traceId);
              openJson("trace-" + traceId + "-api.json", payload);
            }}
          >
            Run Trace
          </button>
        </div>
      </header>

      {trace && (
        <>
          {trace.evidenceProblem && (
            <div className="error-banner" role="alert">
              <span>
                Runtime trace capture was interrupted. {trace.evidenceProblem}
              </span>
            </div>
          )}
          <AuditChain
            chain={detailQuery.data?.auditChain ?? []}
            current={traceId}
          />
          <div className="trace-pane-row">
            <div
              className="pane-toggle view-toggle"
              role="tablist"
              aria-label="Trace view"
            >
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
          </div>
          {failed && (
            <div className="auditor-health auditor-health-failed" role="alert">
              <p className="auditor-health-title">This audit failed</p>
              <p className="auditor-health-body">
                The auditor could not complete.
              </p>
            </div>
          )}
          {audit.isError && (
            <p className="intent-change-error" role="alert">
              {audit.error instanceof Error
                ? audit.error.message
                : "The auditor could not be audited."}
            </p>
          )}
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

      {pane === "auditor" &&
        (auditAttempts.length > 1 || canRetryAudit || action.run) && (
          <div className="audit-attempts">
            <AuditAttempts
              attempts={auditAttempts}
              selectedId={viewingAttemptId ?? ""}
              onSelect={(id) => {
                setAuditorSpanId(null);
                setPinnedAttemptId(id);
              }}
            />
            {action.run && !canRetryAudit && (
              <button
                type="button"
                className="button button-ghost"
                disabled={auditBusy}
                onClick={() => audit.mutate()}
              >
                {audit.isPending ? "Auditing…" : "Audit"}
              </button>
            )}
            {canRetryAudit && (
              <button
                type="button"
                className="button button-ghost"
                disabled={auditBusy}
                onClick={() => audit.mutate()}
              >
                {audit.isPending ? "Auditing…" : "Retry Audit"}
              </button>
            )}
          </div>
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
        (!viewingAttemptId || auditorDetailQuery.error) && (
          <p className="muted-cell">
            The auditor has not recorded any steps yet.
          </p>
        )}

      {pane === "auditor" && action.view && (
        <div className="trace-detail-footer-actions">
          <Link
            className="button button-ghost"
            to={"/traces/" + action.view}
            onClick={followAudit}
          >
            View auditor's trace details
          </Link>
        </div>
      )}

      {showDebugPrompt && trace && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setShowDebugPrompt(false)}
        >
          <div
            className="modal debug-prompt-modal"
            role="dialog"
            aria-labelledby="debug-prompt-heading"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">This run</span>
                <h2 id="debug-prompt-heading">Debug Prompt</h2>
                <p>
                  Standing instructions for a diagnostic agent. Paths are filled
                  in for this run.
                </p>
              </div>
              <button type="button" onClick={() => setShowDebugPrompt(false)}>
                ×
              </button>
            </div>
            <label>
              Prompt
              <textarea
                readOnly
                rows={16}
                value={debugPrompt({
                  origin: window.location.origin,
                  traceId,
                  agentId: trace.agentId,
                  auditOf: trace.auditOf,
                  auditTraceId,
                })}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowDebugPrompt(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
