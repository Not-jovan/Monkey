import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { AuditRecord, AuditTraceStep, TraceRecord } from "../types";
import { formatDateTime } from "./format";

// A trace on its own does not say what the run was measured against. Without
// the objective and the standing constraints in force, a finding like "not in
// alignment" is unreadable — you cannot tell what it failed to align with.

export function TraceIntent({ trace }: { trace: TraceRecord }) {
  const intentQuery = useQuery({
    queryKey: ["intent", trace.agentId],
    queryFn: () => api.intent(trace.agentId),
    // The specification changes only when the user says something, so there is
    // nothing to poll for while looking at a finished run.
    staleTime: 30_000,
  });

  const intent = intentQuery.data?.intent;
  const history = intentQuery.data?.history ?? [];

  // Updates that landed while this run was in flight are the ones that explain
  // a mid-run change of behaviour.
  const runStart = trace.startedAt;
  const runEnd = trace.endedAt ?? new Date().toISOString();
  const during = history.filter(
    (entry) => entry.at >= runStart && entry.at <= runEnd,
  );

  if (!intent || (intent.objective.length === 0 && intent.extended.length === 0)) {
    return null;
  }

  return (
    <section className="trace-intent" aria-labelledby="trace-intent-heading">
      <h2 className="eyebrow" id="trace-intent-heading">
        Judged against
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
      {during.length > 0 && (
        <>
          <h3 className="eyebrow">Changed during this run</h3>
          <ul className="trace-intent-list">
            {during.map((entry) => (
              <li key={entry.id}>
                <span className={"intent-status intent-status-" + entry.status}>
                  {entry.status}
                </span>{" "}
                {entry.objectiveAfter
                  ? "objective → " + entry.objectiveAfter
                  : entry.added.join("; ")}
                <span className="muted-cell"> · {formatDateTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// The flat findings the API already derives. Grouped, so the two questions the
// middleware answers — did it follow the intent, was it safe — read separately.
export function FindingsSummary({
  findings,
  audits,
  onSelect,
}: {
  findings: AuditTraceStep[];
  audits: AuditRecord[];
  onSelect: (spanId: string) => void;
}) {
  if (findings.length === 0) return null;

  // AuditTraceStep ids are "<auditId>#<n>", so the owning audit — and through
  // it the step — is recoverable without widening the published shape.
  const spanFor = (findingId: string) => {
    const auditId = findingId.split("#")[0];
    return audits.find((audit) => audit.id === auditId)?.spanId ?? null;
  };

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
            <ul className="trace-findings-list">
              {rows.map((finding) => {
                const spanId = spanFor(finding.id);
                return (
                  <li key={finding.id}>
                    <span className={"finding-type finding-type-" + finding.type}>
                      {finding.type}
                    </span>
                    {spanId ? (
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
          </div>
        );
      })}
    </section>
  );
}
