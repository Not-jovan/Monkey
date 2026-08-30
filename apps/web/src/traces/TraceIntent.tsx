import type {
  AuditTraceStep,
  TraceIntentView,
  TraceRecord,
} from "../types";

export function TraceIntent({ intent }: { intent: TraceIntentView | null }) {
  if (!intent || (intent.objective.length === 0 && intent.extended.length === 0)) {
    return null;
  }

  return (
    <section className="trace-intent" aria-labelledby="trace-intent-heading">
      <div className="trace-intent-head">
        <h2 className="eyebrow" id="trace-intent-heading">
          Intent
        </h2>
      </div>
      <p className="trace-intent-objective">
        {intent.objective || "(no objective stated)"}
      </p>
      {intent.extended.length > 0 && (
        <>
          <h3 className="eyebrow">Constraints</h3>
          <ul className="trace-intent-list">
            {intent.extended.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// The exhaustiveness check below is deliberate: adding a category without
// giving it a label here is a compile error rather than a blank table cell.
export function findingTypeLabel(category: AuditTraceStep["category"]) {
  if (category === "intent-check") return "Intent";
  if (category === "security") return "Security";
  if (category === "reliability") return "Reliability";
  // A claim about the auditor rather than about the agent. Filtered out of the
  // agent's findings, but shown by the audit of the auditor.
  if (category === "audit-health") return "Audit";
  const _exhaustive: never = category;
  return _exhaustive;
}

// Audit-health findings are noise beside a step's findings about the agent, so
// they are hidden by default. The audit of the auditor is the one place they
// are the subject rather than the noise: every one of its findings carries that
// category, so filtering them there leaves a heading above nothing.
export function visibleFindings(
  findings: AuditTraceStep[],
  includeAuditHealth = false,
) {
  if (includeAuditHealth) return findings;
  return findings.filter((finding) => finding.category !== "audit-health");
}

// Older records concatenated the auditor's outage onto the agent's finding.
// Sometimes that is ` · Primary audit model unavailable: …`; sometimes the
// check labels ride along (` · Summarize · Model · …: Primary audit model…`).
const AUDITOR_HEALTH =
  /Primary audit model unavailable:|The primary audit model failed|The auditor could not complete|ModelNotOpen:/;

export function agentFacingFindingText(text: string) {
  if (!AUDITOR_HEALTH.test(text)) return text.trim();
  const sep = " · ";
  const first = text.indexOf(sep);
  if (first >= 0 && AUDITOR_HEALTH.test(text.slice(first))) {
    return text.slice(0, first).trim();
  }
  const colon = text.indexOf(": ");
  if (colon >= 0 && AUDITOR_HEALTH.test(text.slice(colon))) {
    return text.slice(0, colon).trim();
  }
  return text.trim();
}

export function SpanFindings({
  findings,
  includeAuditHealth = false,
  focusedFindingId,
}: {
  findings: AuditTraceStep[];
  includeAuditHealth?: boolean;
  trace?: TraceRecord;
  focusedFindingId?: string | null;
}) {
  const shown = visibleFindings(findings, includeAuditHealth);
  if (shown.length === 0) return null;
  return (
    <div className="span-audits">
      <span className="eyebrow">Findings</span>
      <table className="findings-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Type</th>
            <th>Finding</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((finding) => (
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
                <span className={"finding-type finding-type-" + finding.type}>
                  {finding.type}
                </span>
              </td>
              <td>{findingTypeLabel(finding.category)}</td>
              <td>
                <div className="finding-copy">
                  {includeAuditHealth
                    ? finding.finding
                    : agentFacingFindingText(finding.finding)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
