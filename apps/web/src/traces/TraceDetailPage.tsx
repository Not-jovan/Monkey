import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api, hasAuthToken, isApiErrorWithStatus, type TraceDetail } from "../api";
import type { AuditTraceStep, TraceRecord, TraceSpan } from "../types";
import { formatDuration, spanDuration } from "./format";
import { stepContext, stepReturn, stepReturnNote } from "./span-context";
import { stepHeadline } from "./steps";
import { TraceCanvas } from "./TraceCanvas";
import { TraceAuditor } from "./TraceAuditor";
import { SpanFindings, TraceIntent } from "./TraceIntent";
import { parseCodexFailure, readCommand } from "./codex-error";
import { buildDiagnosis, recoveryNote } from "./failure";
import { FailureBlock } from "./FailureBlock";
import { FailureSummary } from "./FailureSummary";
import { TextBlock } from "./TextBlock";
import { TraceStepList } from "./TraceStepList";
import { TraceTimeline } from "./TraceTimeline";
import { UsageBars } from "./UsageBars";
import { spanUsage } from "./usage";

// TraceDetail now comes from the API client, so the response shape is declared
// once: it carries auditHealth and the carried-in/out context as well.
type StepView = "graph" | "list" | "timeline";
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
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  if (!opened) {
    download(fileName, data);
  }
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

function SpanDetails({
  span,
  findings,
  trace,
}: {
  span: TraceSpan;
  findings: AuditTraceStep[];
  trace: TraceRecord;
}) {
  const detailOptions = { tracePrompt: trace.prompt, spans: trace.spans };
  const input = stepContext(span, detailOptions);
  const output = stepReturn(span, detailOptions);
  const returnNote = stepReturnNote(span);
  const usage = spanUsage(span);
  // A shell script inside the arguments keeps its escaped newlines, so show the
  // command as real text rather than a one-line JSON blob.
  const command =
    typeof span.attributes.arguments === "string"
      ? readCommand(span.attributes.arguments)
      : null;
  // The failure envelope repeats itself and escapes its newlines; parsing it
  // once replaces both the Output and Error blocks with something diagnosable.
  const failureSource = output || span.error || "";
  const failure = failureSource ? parseCodexFailure(failureSource) : null;
  const hiddenInPanel = new Set([
    "context",
    "output",
    "result",
    "arguments",
    "prompt",
    "inputTokens",
    "cachedTokens",
    "outputTokens",
    "reasoningTokens",
    "toolTokens",
  ]);
  const longText = ["instructions"];
  const attributeEntries = Object.entries(span.attributes).filter(
    ([key]) => !hiddenInPanel.has(key),
  );
  const duration = formatDuration(
    span.durationMs ?? spanDuration(span.startedAt, span.endedAt),
  );

  let errorBlock = null;
  if (failure) {
    errorBlock = <FailureBlock failure={failure} raw={failureSource} />;
  } else if (span.error) {
    errorBlock = <div className="span-error">{span.error}</div>;
  }

  let inputBlock = null;
  if (command) {
    inputBlock = <TextBlock label="Input" text={command} />;
  } else if (input) {
    inputBlock = <TextBlock label="Input" text={input} />;
  }

  return (
    <div className="span-panel">
      <div className="span-panel-head">
        <strong>{stepHeadline(span)}</strong>
        <span className="muted-cell">{duration}</span>
      </div>
      {errorBlock}
      {usage && <UsageBars model={trace.model} usage={usage} />}
      {inputBlock}
      {!failure && output && (
        <TextBlock label="Output" text={output} note={returnNote} />
      )}
      <div className="span-attributes">
        {attributeEntries.map(([key, value]) =>
          longText.includes(key) ? (
            <TextBlock key={key} label={key} text={String(value)} />
          ) : (
            <div className="span-attribute-row" key={key}>
              <span className="attribute-key">{key}</span>
              <span>{String(value)}</span>
            </div>
          ),
        )}
        {attributeEntries.length === 0 && !input && !output && !command && (
          <span className="muted-cell">No recorded attributes.</span>
        )}
      </div>
      <SpanFindings findings={findings} />
    </div>
  );
}

export function TraceDetailPage() {
  const { traceId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [view, setView] = useState<StepView>(readStoredView);
  const [pane, setPane] = useState<TracePane>(() =>
    searchParams.get("pane") === "auditor" ? "auditor" : readStoredPane(),
  );
  const focusedFindingId = searchParams.get("finding");

  const authQuery = useQuery({ queryKey: ["auth"], queryFn: api.auth });
  const locked = authQuery.data?.required === true && !hasAuthToken();

  const detailQuery = useQuery({
    queryKey: ["trace", traceId],
    queryFn: (): Promise<TraceDetail> => api.trace(traceId),
    enabled: !locked && traceId.length > 0,
    refetchInterval: (query: { state: { data: TraceDetail | undefined } }) =>
      query.state.data?.trace.status === "running" ? 1_200 : 4_000,
  });

  const auditorQuery = useQuery({
    queryKey: ["audit", traceId],
    queryFn: () => api.auditor(traceId),
    enabled: !locked && traceId.length > 0,
    refetchInterval: () =>
      detailQuery.data?.trace.status === "running" ||
      detailQuery.data?.auditComplete === false
        ? 1_200
        : 4_000,
  });

  const trace: TraceRecord | null = detailQuery.data?.trace ?? null;
  const findings: AuditTraceStep[] = detailQuery.data?.findings ?? [];

  const agentFindings = findings.filter(
    (finding) => finding.category !== "audit-health",
  );
  const warningsBySpan = new Map<string, number>();
  for (const finding of agentFindings) {
    if (!finding.spanId) continue;
    warningsBySpan.set(
      finding.spanId,
      (warningsBySpan.get(finding.spanId) ?? 0) + 1,
    );
  }
  const warningCount = agentFindings.length;
  const auditHealth = detailQuery.data?.auditHealth ?? "ok";
  const diagnosis = trace ? buildDiagnosis(trace) : null;
  const recovered = trace ? recoveryNote(trace) : null;

  const selectedSpan =
    trace?.spans.find((span) => span.id === selectedSpanId) ?? null;
  const selectedFindings = findings.filter(
    (finding) => finding.spanId === selectedSpanId,
  );

  const chooseView = (next: StepView) => {
    setView(next);
    persistView(next);
  };

  const choosePane = (next: TracePane) => {
    setPane(next);
    persistPane(next);
  };

  const showStep = (spanId: string) => {
    setSelectedSpanId(spanId);
    choosePane("run");
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

  let durationLabel = "—";
  if (trace) {
    if (trace.endedAt) {
      durationLabel = formatDuration(
        spanDuration(trace.startedAt, trace.endedAt),
      );
    } else {
      durationLabel = formatDuration(
        Date.now() - new Date(trace.startedAt).getTime(),
      );
    }
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
          <p className="trace-instruction" title={trace.prompt}>
            {trace.prompt}
          </p>
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
          {pane === "run" && (
            <>
              <div className="trace-badges">
                <span className={"trace-status trace-status-" + trace.status}>
                  {trace.status}
                </span>
                {warningCount > 0 && (
                  <span className="warning-badge">
                    {warningCount} Warning{warningCount === 1 ? "" : "s"}
                  </span>
                )}
                {recovered && (
                  <span className="recovered-badge">↺ {recovered}</span>
                )}
                {!trace.evidenceComplete && (
                  <span
                    className="failure-partial"
                    title="The output cap truncated this run's stream, so some evidence was discarded"
                  >
                    partial evidence
                  </span>
                )}
                <span className="trace-duration">{durationLabel}</span>
              </div>
              <UsageBars model={trace.model} usage={trace.usage} />
            </>
          )}
        </>
      )}

      {pane === "run" && diagnosis && (
        <FailureSummary diagnosis={diagnosis} onSelect={setSelectedSpanId} />
      )}

      {pane === "run" && trace && (
          <TraceIntent intent={detailQuery.data?.intent ?? null} />
      )}

      {pane === "auditor" && trace && (
        <TraceAuditor
          trace={trace}
          findings={findings}
          auditHealth={auditHealth}
          intent={detailQuery.data?.intent ?? null}
          context={detailQuery.data?.context ?? null}
          auditorSpans={auditorQuery.data?.spans ?? []}
          onShowStep={showStep}
          focusedFindingId={focusedFindingId}
        />
      )}

      {pane === "run" && trace && (
        <section className="trace-steps" aria-labelledby="trace-steps-heading">
          <div className="trace-steps-head">
            <h2 className="eyebrow" id="trace-steps-heading">
              Steps
            </h2>
            <div className="view-toggle" role="group" aria-label="Step view">
              <button
                type="button"
                className={view === "graph" ? "is-active" : ""}
                aria-pressed={view === "graph"}
                onClick={() => chooseView("graph")}
              >
                Call Graph
              </button>
              <button
                type="button"
                className={view === "list" ? "is-active" : ""}
                aria-pressed={view === "list"}
                onClick={() => chooseView("list")}
              >
                Call List
              </button>
              <button
                type="button"
                className={view === "timeline" ? "is-active" : ""}
                aria-pressed={view === "timeline"}
                onClick={() => chooseView("timeline")}
              >
                Timeline
              </button>
            </div>
          </div>
          {view === "list" && (
            <TraceStepList
              spans={trace.spans}
              selectedId={selectedSpanId}
              failingSpanId={trace.failingSpanId}
              warningsBySpan={warningsBySpan}
              onSelect={setSelectedSpanId}
            />
          )}
          {view === "graph" && (
            <TraceCanvas
              spans={trace.spans}
              selectedId={selectedSpanId}
              failingSpanId={trace.failingSpanId}
              warningsBySpan={warningsBySpan}
              onSelect={setSelectedSpanId}
            />
          )}
          {view === "timeline" && (
            <TraceTimeline
              spans={trace.spans}
              selectedId={selectedSpanId}
              failingSpanId={trace.failingSpanId}
              warningsBySpan={warningsBySpan}
              onSelect={setSelectedSpanId}
            />
          )}
        </section>
      )}

      {pane === "run" && trace && selectedSpan && (
        <SpanDetails
          findings={selectedFindings}
          span={selectedSpan}
          trace={trace}
        />
      )}
    </div>
  );
}
