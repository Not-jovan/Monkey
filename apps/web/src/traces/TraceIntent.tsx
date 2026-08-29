import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type {
  AuditTraceStep,
  IntentState,
  IntentVersionEntry,
  TraceRecord,
} from "../types";

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

  const versions: IntentVersionEntry[] = intentQuery.data?.versions ?? [];
  const pinnedIndex = intentId
    ? versions.findIndex((entry) => entry.id === intentId)
    : -1;
  const pinned = pinnedIndex >= 0 ? versions[pinnedIndex] : undefined;
  const intent: IntentState | undefined = pinned ?? intentQuery.data?.intent;
  if (!intent || (intent.objective.length === 0 && intent.extended.length === 0)) {
    return null;
  }
  const isStale = pinnedIndex >= 0 && pinnedIndex < versions.length - 1;

  return (
    <section className="trace-intent" aria-labelledby="trace-intent-heading">
      <div className="trace-intent-head">
        <h2 className="eyebrow" id="trace-intent-heading">
          Intent
        </h2>
        {/* Classification runs after the message is sent, so a run can be
            judged against the version that preceded its own correction. */}
        {isStale && (
          <span className="muted-cell">
            This run used an earlier intent; it has changed since
          </span>
        )}
      </div>
      <p className="trace-intent-objective">{intent.objective || "(no objective stated)"}</p>
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
  // A claim about the auditor rather than about the agent. It is filtered out
  // before it reaches this table, but the union still has to be covered.
  if (category === "audit-health") return "Audit";
  const _exhaustive: never = category;
  return _exhaustive;
}

export function SpanFindings({ findings }: { findings: AuditTraceStep[] }) {
  const shown = findings.filter(
    (finding) => finding.category !== "audit-health",
  );
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
