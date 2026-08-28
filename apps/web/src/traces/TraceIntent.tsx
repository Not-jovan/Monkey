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

function findingTypeLabel(category: AuditTraceStep["category"]) {
  if (category === "intent-check") return "Intent";
  if (category === "security") return "Security";
  const _exhaustive: never = category;
  return _exhaustive;
}

export function SpanFindings({ findings }: { findings: AuditTraceStep[] }) {
  if (findings.length === 0) return null;
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
          {findings.map((finding) => (
            <tr key={finding.id}>
              <td>
                <span className={"finding-type finding-type-" + finding.type}>
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
  );
}
