import { useEffect } from "react";
import type { TraceDetail } from "../api";
import type { AuditTraceStep, TraceRecord, TraceSpan } from "../types";
import { isSuccessfulAudit } from "./audit-status";
import { parseCodexFailure, readCommand } from "./codex-error";
import { FailureBlock } from "./FailureBlock";
import { formatDuration, spanDuration, displayTraceEndedAt } from "./format";
import { stepContext, stepReturn, stepReturnNote } from "./span-context";
import { stepHeadline } from "./steps";
import { TextBlock } from "./TextBlock";
import { TraceCanvas } from "./TraceCanvas";
import { TraceDebugAgent } from "./TraceDebugAgent";
import { SpanFindings, TraceIntent } from "./TraceIntent";
import { TraceStepList } from "./TraceStepList";
import { TraceTimeline } from "./TraceTimeline";
import { UsageBars } from "./UsageBars";
import { spanUsage } from "./usage";

export type StepView = "graph" | "list" | "timeline";

function SpanDetails({
  span,
  findings,
  trace,
  includeAuditHealth,
  focusedFindingId,
}: {
  span: TraceSpan;
  findings: AuditTraceStep[];
  trace: TraceRecord;
  includeAuditHealth: boolean;
  focusedFindingId?: string | null;
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
      <SpanFindings
        findings={findings}
        includeAuditHealth={includeAuditHealth}
        trace={trace}
        focusedFindingId={focusedFindingId}
      />
    </div>
  );
}

export function TraceRunView({
  detail,
  view,
  onViewChange,
  selectedSpanId,
  onSelectSpan,
  focusedFindingId,
}: {
  detail: TraceDetail;
  view: StepView;
  onViewChange: (view: StepView) => void;
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
  focusedFindingId?: string | null;
}) {
  const { trace, intent } = detail;
  const isAuditor =
    typeof trace.auditOf === "string" && trace.auditOf.length > 0;
  const auditedOk = isSuccessfulAudit({
    auditComplete: detail.auditComplete,
    auditHealth: detail.auditHealth,
  });
  // Agent runs are judged automatically, so findings land as the pass goes.
  // An auditor is judged only when asked, and a failed pass must not be shown
  // as if it had answered.
  const findings = !isAuditor || auditedOk ? detail.findings : [];
  const includeAuditHealth = isAuditor;
  const counted = includeAuditHealth
    ? findings
    : findings.filter((finding) => finding.category !== "audit-health");
  const warningsBySpan = new Map<string, number>();
  for (const finding of counted) {
    if (!finding.spanId) continue;
    warningsBySpan.set(
      finding.spanId,
      (warningsBySpan.get(finding.spanId) ?? 0) + 1,
    );
  }
  const warningCount = counted.filter(
    (finding) => finding.type !== "suspicion",
  ).length;
  const selectedSpan =
    trace.spans.find((span) => span.id === selectedSpanId) ?? null;
  const selectedFindings = findings.filter(
    (finding) => finding.spanId === selectedSpanId,
  );

  const focusedSpanId =
    findings.find((finding) => finding.id === focusedFindingId)?.spanId ?? null;

  useEffect(() => {
    if (focusedSpanId) onSelectSpan(focusedSpanId);
  }, [focusedSpanId, onSelectSpan]);

  let durationLabel = "—";
  if (trace.endedAt) {
    durationLabel = formatDuration(
      spanDuration(
        trace.startedAt,
        displayTraceEndedAt(trace.endedAt, trace.spans),
      ),
    );
  } else {
    durationLabel = formatDuration(
      Date.now() - new Date(trace.startedAt).getTime(),
    );
  }

  return (
    <>
      <p className="trace-instruction" title={trace.prompt}>
        {trace.prompt}
      </p>
      <div className="trace-badges">
        <span className={"trace-status trace-status-" + trace.status}>
          {trace.status}
        </span>
        {warningCount > 0 && (
          <span className="warning-badge">
            {warningCount} Warning{warningCount === 1 ? "" : "s"}
          </span>
        )}
        {!trace.evidenceComplete && (
          <span
            className="failure-partial"
            title={
              trace.evidenceProblem ??
              "Some runtime evidence was discarded, so this trace is incomplete."
            }
          >
            partial evidence
          </span>
        )}
        <span className="trace-duration">{durationLabel}</span>
      </div>
      <UsageBars model={trace.model} usage={trace.usage} />
      <TraceIntent intent={intent} />

      <section className="trace-steps" aria-labelledby="trace-steps-heading">
        <div className="trace-steps-head">
          <h2 className="eyebrow" id="trace-steps-heading">
            Steps
          </h2>
          <div className="trace-steps-controls">
            <div className="view-toggle" role="group" aria-label="Step view">
              <button
                type="button"
                className={view === "graph" ? "is-active" : ""}
                aria-pressed={view === "graph"}
                onClick={() => onViewChange("graph")}
              >
                Call Graph
              </button>
              <button
                type="button"
                className={view === "list" ? "is-active" : ""}
                aria-pressed={view === "list"}
                onClick={() => onViewChange("list")}
              >
                Call List
              </button>
              <button
                type="button"
                className={view === "timeline" ? "is-active" : ""}
                aria-pressed={view === "timeline"}
                onClick={() => onViewChange("timeline")}
              >
                Timeline
              </button>
            </div>
          </div>
        </div>
        {view === "list" && (
          <TraceStepList
            spans={trace.spans}
            selectedId={selectedSpanId}
            failingSpanId={trace.failingSpanId}
            warningsBySpan={warningsBySpan}
            onSelect={onSelectSpan}
          />
        )}
        {view === "graph" && (
          <TraceCanvas
            spans={trace.spans}
            selectedId={selectedSpanId}
            failingSpanId={trace.failingSpanId}
            warningsBySpan={warningsBySpan}
            onSelect={onSelectSpan}
          />
        )}
        {view === "timeline" && (
          <TraceTimeline
            spans={trace.spans}
            selectedId={selectedSpanId}
            failingSpanId={trace.failingSpanId}
            warningsBySpan={warningsBySpan}
            onSelect={onSelectSpan}
          />
        )}
      </section>

      {selectedSpan && (
        <SpanDetails
          findings={selectedFindings}
          span={selectedSpan}
          trace={trace}
          includeAuditHealth={includeAuditHealth}
          focusedFindingId={focusedFindingId}
        />
      )}

      {/* Agent runs only. An auditor's findings are claims about the auditor;
          a Debug Agent spawned from them would diagnose the wrong subject. */}
      {!isAuditor && <TraceDebugAgent detail={detail} />}
    </>
  );
}
