import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, hasAuthToken, isApiErrorWithStatus } from "../api";
import type { AuditRecord, TraceRecord, TraceSpan } from "../types";
import { formatDateTime, formatDuration, spanDuration } from "./format";
import { TraceCanvas } from "./TraceCanvas";

type TraceDetail = { trace: TraceRecord; audits: AuditRecord[] };

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
        <span className={"audit-status audit-status-" + audit.status}>
          {audit.status}
        </span>
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
}: {
  span: TraceSpan;
  audits: AuditRecord[];
}) {
  const longText = ["prompt", "arguments", "output", "instructions"];
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
      {span.error && <div className="span-error">{span.error}</div>}
      <div className="span-attributes">
        {Object.entries(span.attributes).map(([key, value]) =>
          longText.includes(key) ? (
            <div className="span-attribute-block" key={key}>
              <span className="attribute-key">{key}</span>
              <pre>{String(value)}</pre>
            </div>
          ) : (
            <div className="span-attribute-row" key={key}>
              <span className="attribute-key">{key}</span>
              <span>{String(value)}</span>
            </div>
          ),
        )}
        {Object.keys(span.attributes).length === 0 && (
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
            const payload = await api.exportTrace(traceId);
            download("trace-" + traceId + ".json", payload);
          }}
        >
          Export trace
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

      {trace && (
        <TraceCanvas
          spans={trace.spans}
          selectedId={selectedSpanId}
          failingSpanId={trace.failingSpanId}
          warningsBySpan={warningsBySpan}
          onSelect={setSelectedSpanId}
        />
      )}

      {selectedSpan ? (
        <SpanDetails audits={selectedAudits} span={selectedSpan} />
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
