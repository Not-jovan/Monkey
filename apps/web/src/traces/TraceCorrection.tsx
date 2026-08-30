import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import type { AuditTraceStep, IntentCorrection, TraceRecord } from "../types";
import { agentFacingFindingText, findingTypeLabel, visibleFindings } from "./TraceIntent";

// Which findings a correction was made from. Recorded as a list because one
// correction usually answers several findings that are really one problem.
export function correctedFindingIds(corrections: IntentCorrection[]) {
  const ids = new Set<string>();
  for (const correction of corrections) {
    if (correction.revertedAt !== null) continue;
    for (const findingId of correction.findingIds) ids.add(findingId);
  }
  return ids;
}

// Turning what the auditor found into what the Agent is told.
//
// A finding is evidence, not authority: nothing here changes the Agent until an
// operator selects findings and writes the rule themselves. What they write
// goes onto the Agent's instructions, which is the spec the auditor rebases
// onto for the next run — so the correction takes effect without anything else
// having to be told about it.
export function TraceCorrection({
  trace,
  findings,
  correctable,
}: {
  trace: TraceRecord;
  findings: AuditTraceStep[];
  // False while the run or its audit is still going: the server refuses then,
  // and offering a control that cannot work reads as a broken feature.
  correctable: boolean;
}) {
  const queryClient = useQueryClient();
  // Local to this component, so a correction started against one trace cannot
  // follow the reader to another one — including the next level of an audit.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");

  const corrections = useQuery({
    queryKey: ["corrections", trace.agentId],
    queryFn: () => api.corrections(trace.agentId),
  });
  const entries = corrections.data?.corrections ?? [];
  const alreadyCorrected = correctedFindingIds(entries);
  const newest = [...entries].reverse().find((entry) => entry.revertedAt === null);

  const settle = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["corrections", trace.agentId] }),
      // The spec is the Agent's instructions, so both the intent view and the
      // Agent itself are stale the moment a correction lands.
      queryClient.invalidateQueries({ queryKey: ["intent", trace.agentId] }),
      queryClient.invalidateQueries({ queryKey: ["agents"] }),
    ]);
  };

  const correct = useMutation({
    mutationFn: () => api.correctIntent(trace.id, [...selected], text),
    onSuccess: async () => {
      setSelected(new Set());
      setText("");
      await settle();
    },
  });

  const undo = useMutation({
    mutationFn: (correctionId: string) =>
      api.revertCorrection(trace.agentId, correctionId),
    onSuccess: settle,
  });

  const shown = visibleFindings(findings);
  if (shown.length === 0 && entries.length === 0) return null;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const failure = correct.error ?? undo.error;

  return (
    <section className="trace-correction" aria-labelledby="trace-correction-heading">
      <h2 className="eyebrow" id="trace-correction-heading">
        Correct the Agent
      </h2>

      {shown.length > 0 && (
        <ul className="correction-findings">
          {shown.map((finding) => (
            <li key={finding.id}>
              <label className="correction-finding">
                <input
                  type="checkbox"
                  checked={selected.has(finding.id)}
                  disabled={!correctable || correct.isPending}
                  onChange={() => toggle(finding.id)}
                />
                <span className={"finding-type finding-type-" + finding.type}>
                  {finding.type}
                </span>
                <span className="muted-cell">
                  {findingTypeLabel(finding.category)}
                </span>
                <span className="finding-copy">
                  {agentFacingFindingText(finding.finding)}
                </span>
                {alreadyCorrected.has(finding.id) && (
                  <span className="correction-mark">already corrected</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}

      {shown.length > 0 && (
        <div className="correction-compose">
          <textarea
            value={text}
            rows={2}
            disabled={!correctable || correct.isPending}
            placeholder="Add a rule to this Agent's instructions, in your words"
            onChange={(event) => setText(event.target.value)}
          />
          <button
            type="button"
            className="button button-ghost"
            disabled={
              !correctable ||
              correct.isPending ||
              selected.size === 0 ||
              text.trim().length === 0
            }
            onClick={() => correct.mutate()}
          >
            {correct.isPending
              ? "Applying…"
              : "Apply to instructions" +
                (selected.size > 0 ? " (" + selected.size + ")" : "")}
          </button>
        </div>
      )}

      {!correctable && shown.length > 0 && (
        <p className="muted-cell">
          The Agent can be corrected once this run and its audit have finished.
        </p>
      )}

      {failure && (
        <p className="intent-change-error" role="alert">
          {failure instanceof Error ? failure.message : "The correction failed."}
        </p>
      )}

      {entries.length > 0 && (
        <>
          <h3 className="eyebrow">Corrections so far</h3>
          <ul className="correction-history">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className={entry.revertedAt ? "correction-undone" : undefined}
              >
                <span className="finding-copy">{entry.correction}</span>
                <span className="muted-cell">
                  {entry.findingIds.length} finding
                  {entry.findingIds.length === 1 ? "" : "s"}
                </span>
                {entry.revertedAt ? (
                  <span className="muted-cell">undone</span>
                ) : (
                  // Only the newest still in force: undo restores the spec as
                  // it was immediately before that edit, so offering an older
                  // one would silently drop the corrections after it.
                  newest?.id === entry.id && (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={undo.isPending}
                      onClick={() => undo.mutate(entry.id)}
                    >
                      {undo.isPending ? "Undoing…" : "Undo"}
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
