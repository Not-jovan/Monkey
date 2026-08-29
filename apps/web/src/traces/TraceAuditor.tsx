import type { AuditHealth, AuditTraceStep, ContextView, TraceRecord } from "../types";
import { findingTypeLabel, TraceIntent } from "./TraceIntent";
import { TraceContext } from "./TraceContext";
import { stepHeadline } from "./steps";

function healthCopy(
  health: AuditHealth,
  notes: AuditTraceStep[],
): { title: string; body: string } {
  const recorded = notes
    .map((note) => note.finding)
    .filter((line) => line.length > 0)
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

export function TraceAuditor({
  trace,
  findings,
  auditHealth,
  intentId,
  context,
  onShowStep,
}: {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  auditHealth: AuditHealth;
  intentId: string | null;
  context: ContextView | null;
  onShowStep: (spanId: string) => void;
}) {
  const healthNotes = findings.filter(
    (finding) => finding.category === "audit-health",
  );
  const agentFindings = findings.filter(
    (finding) => finding.category !== "audit-health",
  );
  const copy = healthCopy(auditHealth, healthNotes);

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

      <TraceIntent trace={trace} intentId={intentId} />
      <TraceContext context={context} />

      {agentFindings.length === 0 ? (
        <p className="muted-cell">No findings about this run.</p>
      ) : (
        <section className="auditor-findings" aria-labelledby="auditor-findings-heading">
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
                  <tr key={finding.id}>
                    <td>
                      <span className={"finding-type finding-type-" + finding.type}>
                        {finding.type}
                      </span>
                    </td>
                    <td>{findingTypeLabel(finding.category)}</td>
                    <td>{finding.finding}</td>
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
