import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api";
import type { IntentState } from "../types";
import { describeChange, intentChanges, isMeaningful } from "./intent-diff";

// The specification the auditor judges this agent against, and every change it
// has been through.
//
// The current spec was already shown; the history was not, even though each
// version already recorded the message that caused it and the classifier's
// reasoning. That gap is the one the whole "improvement loop" framing turns on:
// a user who cannot see that their message rewrote the rules cannot tell
// whether their correction landed, and cannot undo it if it landed wrongly.

function formatWhen(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function IntentPanel({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const queryClient = useQueryClient();

  const intentQuery = useQuery({
    queryKey: ["intent", agentId],
    queryFn: () => api.intent(agentId),
    refetchInterval: 4_000,
  });

  const revert = useMutation({
    mutationFn: (intentId: string) => api.revertIntent(agentId, intentId),
    onSuccess: (view) => {
      // Seed rather than invalidate: the response is the new view, and the
      // 4s poll would otherwise show the old spec for up to a full interval.
      queryClient.setQueryData(["intent", agentId], view);
    },
  });

  const intent: IntentState | undefined = intentQuery.data?.intent;
  const allChanges = useMemo(
    () => intentChanges(intentQuery.data?.versions ?? []),
    [intentQuery.data?.versions],
  );
  const changes = useMemo(() => allChanges.filter(isMeaningful), [allChanges]);
  // The real version number, not the count of rows shown. Versions that changed
  // nothing are hidden from the timeline but still occupy a version number, so
  // counting rows would quietly report the wrong one.
  const currentVersion = allChanges.length;

  const hasSpec =
    intent !== undefined &&
    (intent.objective.length > 0 || intent.extended.length > 0);
  if (!hasSpec || !intent) return <div className="intent-panel" />;

  // One entry is just the starting spec; there is no history to tell yet.
  const hasHistory = changes.length > 1;

  return (
    <div className="intent-panel">
      <div className="intent-current">
        <button
          className="intent-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="eyebrow">Current intent</span>
          <span className="muted-cell">
            {intent.extended.length > 0
              ? intent.extended.length +
                " constraint" +
                (intent.extended.length === 1 ? "" : "s")
              : "objective only"}
          </span>
          {hasHistory && (
            <span className="intent-version">v{currentVersion}</span>
          )}
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
        {expanded && (
          <div className="intent-detail">
            <p>
              <strong>Objective:</strong> {intent.objective || "(none stated)"}
            </p>
            {intent.extended.length > 0 && (
              <ul>
                {intent.extended.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            )}
            {hasHistory && (
              <button
                type="button"
                className="intent-history-toggle"
                aria-expanded={showHistory}
                onClick={() => setShowHistory((value) => !value)}
              >
                {showHistory ? "Hide" : "Show"} spec history ({changes.length}{" "}
                versions)
              </button>
            )}
          </div>
        )}
      </div>

      {expanded && showHistory && (
        <ol className="intent-history">
          {[...changes].reverse().map((change) => (
            <li
              key={change.id}
              className={
                "intent-change" + (change.isCurrent ? " is-current" : "")
              }
            >
              <div className="intent-change-head">
                <span className="intent-version">v{change.version}</span>
                <strong>{describeChange(change)}</strong>
                {change.createdAt && (
                  <span className="muted-cell">
                    {formatWhen(change.createdAt)}
                  </span>
                )}
                {change.isCurrent ? (
                  <span className="intent-current-flag">in force</span>
                ) : (
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={revert.isPending}
                    onClick={() => revert.mutate(change.id)}
                  >
                    Revert to this
                  </button>
                )}
              </div>

              {change.trigger && change.kind !== "human-correction" && (
                <p className="intent-change-trigger">
                  From your message: &ldquo;{change.trigger}&rdquo;
                </p>
              )}
              {change.kind === "human-correction" && change.trigger && (
                <p className="intent-change-trigger">
                  Human correction: &ldquo;{change.trigger}&rdquo;
                  {change.traceId && change.sources.length > 0 && (
                    <>
                      {" Evidence: "}
                      {change.sources.map((source, index) => (
                        <span key={source.findingId}>
                          {index > 0 && ", "}
                          <Link
                            to={
                              "/traces/" +
                              change.traceId +
                              "?pane=auditor&finding=" +
                              encodeURIComponent(source.findingId)
                            }
                          >
                            {change.sources.length === 1
                              ? "view source finding"
                              : "finding " + (index + 1)}
                          </Link>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              )}
              {change.reason && (
                <p className="muted-cell">
                  {change.kind === "human-correction" ? "Decision: " : "Classifier: "}
                  {change.reason}
                </p>
              )}
              {change.objectiveBefore !== null && (
                <p className="intent-change-objective">
                  <span className="intent-removed">
                    {change.objectiveBefore}
                  </span>{" "}
                  → <span className="intent-added">{change.objectiveAfter}</span>
                </p>
              )}
              {(change.addedConstraints.length > 0 ||
                change.removedConstraints.length > 0) && (
                <ul className="intent-change-list">
                  {change.addedConstraints.map((entry) => (
                    <li className="intent-added" key={"add-" + entry}>
                      + {entry}
                    </li>
                  ))}
                  {change.removedConstraints.map((entry) => (
                    <li className="intent-removed" key={"remove-" + entry}>
                      − {entry}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      {revert.isError && (
        <p className="intent-change-error" role="alert">
          That version could not be restored.
        </p>
      )}
    </div>
  );
}
