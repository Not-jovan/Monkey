import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type IntentView } from "../api";
import type {
  AuditHealth,
  AuditTraceStep,
  ContextView,
  IntentVersionEntry,
  TraceIntentView,
  TraceRecord,
  TraceSpan,
} from "../types";
import { formatDuration, spanDuration } from "./format";
import { stepContext, stepReturn } from "./span-context";
import { findingTypeLabel, SpanFindings, TraceIntent } from "./TraceIntent";
import { TraceContext } from "./TraceContext";
import { TraceStepList } from "./TraceStepList";
import { TraceTimeline } from "./TraceTimeline";
import { TextBlock } from "./TextBlock";
import { stepHeadline } from "./steps";

type AuditorView = "list" | "timeline";

function HumanCorrection({
  trace,
  finding,
}: {
  trace: TraceRecord;
  finding: AuditTraceStep;
}) {
  const [editing, setEditing] = useState(false);
  const [correction, setCorrection] = useState("");
  const queryClient = useQueryClient();
  const intentQuery = useQuery<IntentView>({
    queryKey: ["intent", trace.agentId],
    queryFn: () => api.intent(trace.agentId),
  });
  const versions: IntentVersionEntry[] = intentQuery.data?.versions ?? [];
  const appliedIndex = versions.findIndex(
    (entry) => entry.update?.sourceFindingId === finding.id,
  );
  const appliedVersion =
    appliedIndex >= 0 ? versions[appliedIndex] : undefined;
  const appliedConstraints: string[] =
    appliedVersion?.update?.addedConstraints ?? [];
  const isActive =
    appliedConstraints.length > 0 &&
    appliedConstraints.every((entry) =>
      (intentQuery.data?.intent.extended ?? []).includes(entry),
    );
  const apply = useMutation({
    mutationFn: () => api.correctIntent(trace.id, finding.id, correction),
    onSuccess: (view) => {
      queryClient.setQueryData(["intent", trace.agentId], view);
      setEditing(false);
    },
  });

  if (appliedIndex >= 0) {
    return (
      <div className="finding-correction finding-correction-applied">
        <span
          className={
            "intent-status intent-status-" + (isActive ? "applied" : "rejected")
          }
        >
          {isActive
            ? "Applied as intent v" + (appliedIndex + 1)
            : "Reverted (intent v" + (appliedIndex + 1) + ")"}
        </span>
        <Link to={"/?agent=" + encodeURIComponent(trace.agentId)}>
          Open Playground
        </Link>
      </div>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="button button-ghost"
        onClick={() => setEditing(true)}
      >
        Correct this
      </button>
    );
  }

  return (
    <div className="finding-correction">
      <label htmlFor={"correction-" + finding.id}>
        Correction for future runs
      </label>
      <textarea
        id={"correction-" + finding.id}
        value={correction}
        maxLength={1_000}
        placeholder="Example: Do not contact hosts outside the configured network whitelist."
        onChange={(event) => setCorrection(event.target.value)}
      />
      <p className="muted-cell">
        Applying this adds a reversible constraint to the Agent's intent.
      </p>
      <div className="finding-correction-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={apply.isPending || correction.trim().length === 0}
          onClick={() => apply.mutate()}
        >
          Apply correction
        </button>
        <button
          type="button"
          className="button button-ghost"
          disabled={apply.isPending}
          onClick={() => {
            setEditing(false);
            setCorrection("");
            apply.reset();
          }}
        >
          Cancel
        </button>
      </div>
      {apply.isError && (
        <p className="intent-change-error" role="alert">
          {apply.error instanceof Error
            ? apply.error.message
            : "The correction could not be applied."}
        </p>
      )}
    </div>
  );
}

export function healthCopy(
  health: AuditHealth,
  notes: AuditTraceStep[],
): { title: string; body: string } {
  // One outage is reported separately by every audited step, so the same
  // sentence arrives once per step. How many steps it covered is worth saying;
  // printing it that many times is not.
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (note.finding.length === 0) continue;
    counts.set(note.finding, (counts.get(note.finding) ?? 0) + 1);
  }
  const recorded = [...counts]
    .map(([message, count]) => {
      if (count === 1) return message;
      return message + " (on " + count + " audited steps)";
    })
    .join(" ");
  if (health === "ok") {
    return {
      title: "Auditor completed",
      body: "The primary audit model judged this run.",
    };
  }
  if (health === "degraded") {
    return {
      title: "Auditor used a fallback model",
      body:
        recorded ||
        "The primary audit model failed. A secondary model still produced a verdict; the original error was not stored for this run.",
    };
  }
  return {
    title: "Auditor did not complete",
    body:
      recorded ||
      "Neither audit model produced a verdict. The original error was not stored for this run.",
  };
}

function AuditorSpanDetails({
  span,
  agentTrace,
  findings,
  onShowStep,
}: {
  span: TraceSpan;
  agentTrace: TraceRecord;
  findings: AuditTraceStep[];
  onShowStep: (spanId: string) => void;
}) {
  const input = stepContext(span, { spans: [span] });
  const output = stepReturn(span, { spans: [span] });
  const duration = formatDuration(
    span.durationMs ?? spanDuration(span.startedAt, span.endedAt),
  );
  const model =
    typeof span.attributes.model === "string" ? span.attributes.model : null;
  const targetSpanId =
    typeof span.attributes.targetSpanId === "string"
      ? span.attributes.targetSpanId
      : null;
  const targetSpan = targetSpanId
    ? agentTrace.spans.find((entry) => entry.id === targetSpanId)
    : undefined;
  const relatedFindings = findings.filter((finding) =>
    targetSpanId
      ? finding.spanId === targetSpanId
      : finding.spanId === null && finding.category !== "audit-health",
  );
  const hidden = new Set([
    "context",
    "output",
    "model",
    "phase",
    "fallback",
    "targetSpanId",
    "laneId",
  ]);
  const extras = Object.entries(span.attributes).filter(
    ([key]) => !hidden.has(key),
  );

  return (
    <div className="span-panel">
      <div className="span-panel-head">
        <strong>{stepHeadline(span)}</strong>
        <span className="muted-cell">{duration}</span>
      </div>
      {span.error && <div className="span-error">{span.error}</div>}
      {model && (
        <div className="span-attribute-row">
          <span className="attribute-key">model</span>
          <span>{model}</span>
        </div>
      )}
      {targetSpan && (
        <div className="span-attribute-row">
          <span className="attribute-key">audited step</span>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => onShowStep(targetSpan.id)}
          >
            {stepHeadline(targetSpan)}
          </button>
        </div>
      )}
      {input && <TextBlock label="Input" text={input} />}
      {output && <TextBlock label="Output" text={output} />}
      {extras.map(([key, value]) => (
        <div className="span-attribute-row" key={key}>
          <span className="attribute-key">{key}</span>
          <span>{String(value)}</span>
        </div>
      ))}
      {relatedFindings.length > 0 && (
        <div className="span-audits">
          <span className="eyebrow">Findings from this call</span>
          <table className="findings-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Type</th>
                <th>Finding</th>
              </tr>
            </thead>
            <tbody>
              {relatedFindings.map((finding) => (
                <tr key={finding.id}>
                  <td>
                    <span
                      className={"finding-type finding-type-" + finding.type}
                    >
                      {finding.type}
                    </span>
                  </td>
                  <td>{findingTypeLabel(finding.category)}</td>
                  <td>{finding.finding}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function TraceAuditor({
  trace,
  findings,
  auditHealth,
  intent,
  context,
  auditorSpans,
  auditTraceId,
  legacyMetaAudit,
  legacyMetaAuditedAt,
  onShowStep,
  focusedFindingId,
}: {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  auditHealth: AuditHealth;
  intent: TraceIntentView | null;
  context: ContextView | null;
  auditorSpans: TraceSpan[];
  auditTraceId: string | null;
  legacyMetaAudit: AuditTraceStep[];
  legacyMetaAuditedAt: string | null;
  onShowStep: (spanId: string) => void;
  focusedFindingId?: string | null;
}) {
  const [view, setView] = useState<AuditorView>("list");
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Judges the auditor whose steps are shown below — which is a trace like any
  // other, so this is the same call at every depth. The answer lands on that
  // trace, which is where we then go.
  const auditTheAuditor = useMutation({
    mutationFn: () => {
      if (auditTraceId === null) {
        throw new Error("This run has not been audited yet.");
      }
      return api.audit(auditTraceId);
    },
    onSuccess: () => {
      // Both keys, because the destination page reads under both and would
      // otherwise show the state from before this audit ran.
      void queryClient.invalidateQueries({ queryKey: ["audit", auditTraceId] });
      void queryClient.invalidateQueries({ queryKey: ["trace", auditTraceId] });
      void navigate("/traces/" + auditTraceId);
    },
  });
  const auditPending = auditTheAuditor.isPending;
  const healthNotes = findings.filter(
    (finding) => finding.category === "audit-health",
  );
  const agentFindings = findings.filter(
    (finding) => finding.category !== "audit-health",
  );
  const copy = healthCopy(auditHealth, healthNotes);
  const selectedSpan =
    auditorSpans.find((span) => span.id === selectedSpanId) ?? null;
  const failingSpanId =
    auditorSpans.find((span) => span.status === "error")?.id ?? null;
  const warningsBySpan = new Map<string, number>();
  for (const span of auditorSpans) {
    const target =
      typeof span.attributes.targetSpanId === "string"
        ? span.attributes.targetSpanId
        : null;
    const count = agentFindings.filter((finding) =>
      target ? finding.spanId === target : finding.spanId === null,
    ).length;
    if (count > 0) warningsBySpan.set(span.id, count);
  }

  return (
    <div className="trace-auditor">
      <section
        className={"auditor-health auditor-health-" + auditHealth}
        aria-labelledby="auditor-health-heading"
      >
        <h2 className="eyebrow" id="auditor-health-heading">
          Auditor
        </h2>
        <p className="auditor-health-title">{copy.title}</p>
        <p className="auditor-health-body">{copy.body}</p>
      </section>

      {auditTheAuditor.isError && (
        <p className="intent-change-error" role="alert">
          {auditTheAuditor.error instanceof Error
            ? auditTheAuditor.error.message
            : "The auditor could not be audited."}
        </p>
      )}

      {/* Recorded when an audit of the auditor lived on the audited run's own
          document, before the auditor's work became a trace. Read-only, and
          shown only where one was actually taken: a finding already recorded
          should not vanish because the shape around it changed. */}
      {legacyMetaAudit.length > 0 && (
        <section className="meta-audit" aria-labelledby="meta-audit-heading">
          <div className="trace-steps-head">
            <h2 className="eyebrow" id="meta-audit-heading">
              Audit of the auditor · recorded by an earlier version
            </h2>
            {legacyMetaAuditedAt && (
              <span className="muted-cell">
                {new Date(legacyMetaAuditedAt).toLocaleString()}
              </span>
            )}
          </div>
          <SpanFindings findings={legacyMetaAudit} includeAuditHealth />
        </section>
      )}

      <TraceIntent intent={intent} />
      <TraceContext context={context} />

      <section className="trace-steps" aria-labelledby="auditor-steps-heading">
        <div className="trace-steps-head">
          <h2 className="eyebrow" id="auditor-steps-heading">
            Auditor steps
          </h2>
          <div className="auditor-actions">
            {/* The steps below belong to a run of their own, which reads like
                any other trace — so it opens like one, at any depth. */}
            {auditTraceId && (
              <Link
                className="button button-ghost"
                to={"/traces/" + auditTraceId}
              >
                Open this auditor&rsquo;s trace
              </Link>
            )}
            {/* Deliberately a button and not something that happens on its own.
                An auditor's steps are real trace spans, so judging them
                produces more of the same; if this ran automatically it would
                feed itself without limit. Every level is one click, and the
                stack goes as deep as someone chooses to take it. */}
            <button
              type="button"
              className="button button-ghost"
              disabled={auditPending || auditTraceId === null}
              onClick={() => auditTheAuditor.mutate()}
            >
              {auditPending ? "Auditing…" : "Audit this auditor"}
            </button>
            <a
              className="button button-ghost"
              href={api.auditArchiveUrl(trace.id)}
              download
            >
              Download artifacts
            </a>
          </div>
          <div
            className="view-toggle"
            role="group"
            aria-label="Auditor step view"
          >
            <button
              type="button"
              className={view === "list" ? "is-active" : ""}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              Call List
            </button>
            <button
              type="button"
              className={view === "timeline" ? "is-active" : ""}
              aria-pressed={view === "timeline"}
              onClick={() => setView("timeline")}
            >
              Timeline
            </button>
          </div>
        </div>
        {auditorSpans.length === 0 ? (
          <p className="muted-cell">
            The auditor has not recorded any steps yet.
          </p>
        ) : view === "list" ? (
          <TraceStepList
            spans={auditorSpans}
            selectedId={selectedSpanId}
            failingSpanId={failingSpanId}
            warningsBySpan={warningsBySpan}
            onSelect={setSelectedSpanId}
          />
        ) : (
          <TraceTimeline
            spans={auditorSpans}
            selectedId={selectedSpanId}
            failingSpanId={failingSpanId}
            warningsBySpan={warningsBySpan}
            onSelect={setSelectedSpanId}
          />
        )}
      </section>

      {selectedSpan && (
        <AuditorSpanDetails
          span={selectedSpan}
          agentTrace={trace}
          findings={agentFindings}
          onShowStep={onShowStep}
        />
      )}

      {agentFindings.length === 0 ? (
        <p className="muted-cell">No findings about this run.</p>
      ) : (
        <section
          className="auditor-findings"
          aria-labelledby="auditor-findings-heading"
        >
          <h2 className="eyebrow" id="auditor-findings-heading">
            Findings
          </h2>
          <table className="findings-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Type</th>
                <th>Finding</th>
                <th>Step</th>
              </tr>
            </thead>
            <tbody>
              {agentFindings.map((finding) => {
                const span = finding.spanId
                  ? trace.spans.find((entry) => entry.id === finding.spanId)
                  : undefined;
                return (
                  <tr
                    key={finding.id}
                    data-finding-id={finding.id}
                    className={
                      finding.id === focusedFindingId
                        ? "finding-row-focused"
                        : undefined
                    }
                  >
                    <td>
                      <span
                        className={"finding-type finding-type-" + finding.type}
                      >
                        {finding.type}
                      </span>
                    </td>
                    <td>{findingTypeLabel(finding.category)}</td>
                    <td>
                      <div className="finding-copy">{finding.finding}</div>
                      {finding.category !== "audit-health" && (
                        <HumanCorrection trace={trace} finding={finding} />
                      )}
                    </td>
                    <td>
                      {span ? (
                        <button
                          type="button"
                          className="button button-ghost"
                          onClick={() => onShowStep(span.id)}
                        >
                          {stepHeadline(span)}
                        </button>
                      ) : (
                        <span className="muted-cell">Run</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
