import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, hasAuthToken, isApiErrorWithStatus } from "../api";
import type {
  AuditRecord,
  AuditTraceStep,
  TraceRecord,
  TraceSpan,
} from "../types";
import { formatDateTime, formatDuration, spanDuration } from "./format";
import { stepContext, stepReturn, stepReturnNote } from "./span-context";
import { TraceCanvas } from "./TraceCanvas";
import { FindingsSummary, TraceIntent } from "./TraceIntent";
import { parseCodexFailure, readCommand } from "./codex-error";
import { FailureBlock } from "./FailureBlock";
import { TextBlock } from "./TextBlock";
import { TraceStepList } from "./TraceStepList";

type TraceDetail = {
  trace: TraceRecord;
  audits: AuditRecord[];
  findings?: AuditTraceStep[];
};

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

function AuditCard({ audit }: { audit: AuditRecord }) {
  return (
    <div className={"audit-card " + (audit.warning ? "audit-warning" : "")}>
      <div className="audit-card-head">
        <span className={"audit-chip audit-" + audit.type}>{audit.type}</span>
        <span
          className={"audit-status audit-status-" + audit.status}
          title={
            audit.status === "degraded"
              ? "The primary audit model was unavailable; this verdict came from the fallback model."
              : audit.status === "failed"
                ? "No model could be reached. Deterministic checks below still stand."
                : "Judged by the configured audit model."
          }
        >
          {audit.status}
        </span>
        {audit.status === "degraded" && (
          <span className="muted-cell">
            primary model unavailable — judged by the fallback
          </span>
        )}
        {audit.model && <span className="muted-cell">{audit.model}</span>}
        <span className="muted-cell">{formatDuration(audit.latencyMs)}</span>
      </div>
      {audit.findings.length > 0 && (
        <div className="audit-findings">
          {audit.findings.map((finding) => (
            <span className="warning-badge" key={finding}>
              ⚠ {finding}
            </span>
          ))}
        </div>
      )}
      {(audit.notInAlignment?.length ?? 0) > 0 && (
        <div className="audit-policy">
          <span className="eyebrow">Not in alignment with the intent</span>
          <ul>
            {audit.notInAlignment?.map((entry) => (
              <li className="audit-prose" key={entry}>
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(audit.newObjectives?.length ?? 0) > 0 && (
        <div className="audit-policy">
          <span className="eyebrow">Objectives the user did not ask for</span>
          <ul>
            {audit.newObjectives?.map((objective) => (
              <li className="audit-prose" key={objective.objective}>
                {objective.objective}{" "}
                <span
                  className={
                    objective.actedUpon ? "warning-badge" : "muted-cell"
                  }
                >
                  {objective.actedUpon ? "⚠ acted upon" : "not acted upon"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(audit.networkViolations?.length ?? 0) > 0 && (
        <div className="audit-policy">
          <span className="eyebrow">Outside the whitelist</span>
          <ul>
            {audit.networkViolations?.map((url) => (
              <li key={url}>{url}</li>
            ))}
          </ul>
        </div>
      )}
      {(audit.secretExposures?.length ?? 0) > 0 && (
        <div className="audit-policy">
          <span className="eyebrow">Credentials observed</span>
          <ul>
            {audit.secretExposures?.map((exposure) => (
              <li key={exposure.location + exposure.secretType}>
                {exposure.secretType}{" "}
                <span className="muted-cell">
                  {exposure.location === "request" ? "sent outward" : "received"}
                </span>{" "}
                {exposure.relevant === false && (
                  <span className="warning-badge">⚠ unrelated</span>
                )}
                {exposure.relevant === true && (
                  <span className="muted-cell">relevant</span>
                )}
                {exposure.relevant == null && (
                  <span className="muted-cell">relevance unknown</span>
                )}
                {exposure.reason && (
                  <span className="muted-cell"> — {exposure.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {audit.reason && <p>{audit.reason}</p>}
      {audit.contextSummary && (
        <p className="muted-cell">Context: {audit.contextSummary}</p>
      )}
    </div>
  );
}

function SpanDetails({
  span,
  audits,
  trace,
}: {
  span: TraceSpan;
  audits: AuditRecord[];
  trace: TraceRecord;
}) {
  const detailOptions = { tracePrompt: trace.prompt, spans: trace.spans };
  const input = stepContext(span, detailOptions);
  const output = stepReturn(span, detailOptions);
  const returnNote = stepReturnNote(span);
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
  ]);
  const longText = ["instructions"];
  const attributeEntries = Object.entries(span.attributes).filter(
    ([key]) => !hiddenInPanel.has(key),
  );
  return (
    <div className="span-panel">
      <div className="span-panel-head">
        <div>
          <span className={"trace-status trace-status-" + span.status}>
            {span.status}
          </span>
          <strong>{span.label}</strong>
        </div>
        <span className="muted-cell">
          {formatDateTime(span.startedAt)} ·{" "}
          {formatDuration(
            span.durationMs ?? spanDuration(span.startedAt, span.endedAt),
          )}
        </span>
      </div>
      {command ? (
        <TextBlock label="Command" text={command} />
      ) : (
        input && <TextBlock label="Input" text={input} />
      )}
      {failure ? (
        <FailureBlock failure={failure} raw={failureSource} />
      ) : (
        <>
          {output && <TextBlock label="Output" text={output} note={returnNote} />}
          {span.error && (
            <div className="span-context-block">
              <span className="eyebrow">Error</span>
              <div className="span-error">{span.error}</div>
            </div>
          )}
        </>
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
        {attributeEntries.length === 0 && !input && !output && (
          <span className="muted-cell">No recorded attributes.</span>
        )}
      </div>
      {audits.length > 0 && (
        <div className="span-audits">
          <span className="eyebrow">Step audits</span>
          {audits.map((audit) => (
            <AuditCard audit={audit} key={audit.id} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TraceDetailPage() {
  const { traceId = "" } = useParams();
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const authQuery = useQuery({ queryKey: ["auth"], queryFn: api.auth });
  const locked = authQuery.data?.required === true && !hasAuthToken();

  const detailQuery = useQuery({
    queryKey: ["trace", traceId],
    queryFn: (): Promise<TraceDetail> => api.trace(traceId),
    enabled: !locked && traceId.length > 0,
    refetchInterval: (query: { state: { data: TraceDetail | undefined } }) =>
      query.state.data?.trace.status === "running" ? 1_200 : 4_000,
  });

  const trace: TraceRecord | null = detailQuery.data?.trace ?? null;
  const audits: AuditRecord[] = detailQuery.data?.audits ?? [];
  const findings: AuditTraceStep[] = detailQuery.data?.findings ?? [];
  const [view, setView] = useState<"list" | "flow">(() => {
    try {
      return localStorage.getItem("trace-view") === "list" ? "list" : "flow";
    } catch {
      // Private windows and blocked site data throw on access.
      return "list";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("trace-view", view);
    } catch {
      // Remembering the choice is a convenience, never a requirement.
    }
  }, [view]);

  const warningsBySpan = new Map<string, number>();
  for (const audit of audits) {
    if (!audit.warning || !audit.spanId) continue;
    warningsBySpan.set(
      audit.spanId,
      (warningsBySpan.get(audit.spanId) ?? 0) + 1,
    );
  }
  const runAudits = audits.filter((audit) => audit.phase === "run");
  const warningCount = audits.filter((audit) => audit.warning).length;

  const selectedSpan =
    trace?.spans.find((span) => span.id === selectedSpanId) ?? null;
  const selectedAudits = audits.filter(
    (audit) => audit.spanId === selectedSpanId,
  );

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
          ← Back to traces
        </Link>
      </div>
    );
  }

  return (
    <div className="glassbox-page">
      <header className="glassbox-topbar">
        <div className="trace-headline">
          <Link className="button button-ghost" to="/traces">
            ←
          </Link>
          <div>
            <span className="eyebrow">Run trace</span>
            <h1>{trace ? formatDateTime(trace.startedAt) : "Loading…"}</h1>
          </div>
          {trace && (
            <span className={"trace-status trace-status-" + trace.status}>
              {trace.status}
            </span>
          )}
          {warningCount > 0 && (
            <span className="warning-badge warning-badge-large">
              ⚠ {warningCount} audit warning{warningCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          className="button button-primary"
          disabled={!trace}
          onClick={async () => {
            const payload = await api.downloadTrace(traceId);
            download("trace-" + traceId + ".json", payload);
          }}
        >
          Download trace
        </button>
      </header>

      {trace && (
        <section className="trace-meta">
          <div>
            <span className="eyebrow">Prompt</span>
            <p>{trace.prompt}</p>
          </div>
          <div className="trace-meta-stats">
            <span>{trace.model ?? "model n/a"}</span>
            <span>
              {trace.usage.inputTokens} in · {trace.usage.outputTokens} out ·{" "}
              {trace.usage.cachedTokens} cached · {trace.usage.reasoningTokens}{" "}
              reasoning
            </span>
            <span>
              {trace.spans.length} spans
              {trace.unrecognizedEvents > 0
                ? " · " + trace.unrecognizedEvents + " unrecognized events"
                : ""}
            </span>
          </div>
        </section>
      )}

      {trace && <TraceIntent trace={trace} />}

      {trace && (
        <FindingsSummary
          findings={findings}
          audits={audits}
          onSelect={setSelectedSpanId}
        />
      )}

      {trace && (
        <section className="trace-steps" aria-labelledby="trace-steps-heading">
          <div className="trace-steps-head">
            <h2 className="eyebrow" id="trace-steps-heading">
              Steps
            </h2>
            <div className="view-toggle" role="group" aria-label="Step view">
              <button
                type="button"
                className={view === "flow" ? "is-active" : ""}
                aria-pressed={view === "flow"}
                onClick={() => setView("flow")}
              >
                Flow
              </button>
              <button
                type="button"
                className={view === "list" ? "is-active" : ""}
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                List
              </button>
            </div>
          </div>
          {view === "list" ? (
            <TraceStepList
              spans={trace.spans}
              selectedId={selectedSpanId}
              failingSpanId={trace.failingSpanId}
              warningsBySpan={warningsBySpan}
              onSelect={setSelectedSpanId}
            />
          ) : (
            <TraceCanvas
              spans={trace.spans}
              selectedId={selectedSpanId}
              failingSpanId={trace.failingSpanId}
              warningsBySpan={warningsBySpan}
              onSelect={setSelectedSpanId}
            />
          )}
        </section>
      )}

      {trace && selectedSpan ? (
        <SpanDetails
          audits={selectedAudits}
          span={selectedSpan}
          trace={trace}
        />
      ) : (
        <div className="span-panel span-panel-hint">
          Select a step in the flow above to inspect its details and audit
          verdicts. Drag to pan.
        </div>
      )}

      {runAudits.length > 0 && (
        <section className="run-audits">
          <span className="eyebrow">Run-level intent audit</span>
          {runAudits.map((audit) => (
            <AuditCard audit={audit} key={audit.id} />
          ))}
        </section>
      )}
    </div>
  );
}
