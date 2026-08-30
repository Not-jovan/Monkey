import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type IntentView } from "../api";
import type {
  AuditTraceStep,
  IntentVersionEntry,
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
        {/* Classification runs after the message is sent, so a run can be
            judged against the version that preceded its own correction. */}
        {intent.stale && (
          <span className="muted-cell">
            This run used an earlier intent; it has changed since
          </span>
        )}
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

export function SpanFindings({
  findings,
  includeAuditHealth = false,
  trace,
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
                <div className="finding-copy">{finding.finding}</div>
                {trace && finding.category !== "audit-health" && (
                  <HumanCorrection trace={trace} finding={finding} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
