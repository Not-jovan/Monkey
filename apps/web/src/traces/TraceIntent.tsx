import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { AuditTraceStep, IntentState, TraceRecord } from "../types";

export function TraceIntent({
  trace,
  intentId,
}: {
  trace: TraceRecord;
  intentId: string | null;
}) {
  const intentQuery = useQuery({
    queryKey: ["intent", trace.agentId],
    queryFn: () => api.intent(trace.agentId),
    staleTime: 30_000,
  });

  let intent: IntentState | undefined = intentQuery.data?.intent;
  if (intentId) {
    const pinned = intentQuery.data?.versions[intentId];
    if (pinned) {
      intent = pinned;
    }
  }
  if (!intent || (intent.objective.length === 0 && intent.extended.length === 0)) {
    return null;
  }

  return (
    <section className="trace-intent" aria-labelledby="trace-intent-heading">
      <h2 className="eyebrow" id="trace-intent-heading">
        Spec in force
      </h2>
      <p className="trace-intent-objective">{intent.objective || "(no objective stated)"}</p>
      {intent.extended.length > 0 && (
        <>
          <h3 className="eyebrow">Standing constraints</h3>
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

function FindingList({
  findings,
  onSelect,
}: {
  findings: AuditTraceStep[];
  onSelect?: (spanId: string) => void;
}) {
  return (
    <ul className="trace-findings-list">
      {findings.map((finding) => {
        const spanId = finding.spanId;
        return (
          <li key={finding.id}>
            <span className={"finding-type finding-type-" + finding.type}>
              {finding.type}
            </span>
            {onSelect && spanId ? (
              <button
                type="button"
                className="finding-link"
                onClick={() => onSelect(spanId)}
              >
                {finding.finding}
              </button>
            ) : (
              <span>{finding.finding}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Grouped so the two questions the auditor answers — did it follow the intent,
// was it safe — read separately.
export function FindingsSummary({
  findings,
  onSelect,
}: {
  findings: AuditTraceStep[];
  onSelect: (spanId: string) => void;
}) {
  if (findings.length === 0) return null;

  const groups: { key: AuditTraceStep["category"]; title: string }[] = [
    { key: "intent-check", title: "Intent" },
    { key: "security", title: "Security" },
  ];

  return (
    <section className="trace-findings" aria-labelledby="trace-findings-heading">
      <h2 className="eyebrow" id="trace-findings-heading">
        Findings ({findings.length})
      </h2>
      {groups.map((group) => {
        const rows = findings.filter((finding) => finding.category === group.key);
        if (rows.length === 0) return null;
        return (
          <div key={group.key}>
            <h3 className="eyebrow">{group.title}</h3>
            <FindingList findings={rows} onSelect={onSelect} />
          </div>
        );
      })}
    </section>
  );
}

export function SpanFindings({ findings }: { findings: AuditTraceStep[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="span-audits">
      <span className="eyebrow">Findings</span>
      <FindingList findings={findings} />
    </div>
  );
}
