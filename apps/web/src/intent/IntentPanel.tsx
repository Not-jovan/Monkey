import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { IntentState } from "../types";
import { describeChange, intentChanges, isMeaningful } from "./intent-diff";

// The specification the last audit derived for this agent, and every earlier
// derivation. History is the sequence of audits, not a standing store a person
// can rewind from here.

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

  const intentQuery = useQuery({
    queryKey: ["intent", agentId],
    queryFn: () => api.intent(agentId),
    refetchInterval: 4_000,
  });

  const intent: IntentState | undefined = intentQuery.data?.intent;
  const diverged = intentQuery.data?.diverged ?? false;
  const allChanges = useMemo(
    () => intentChanges(intentQuery.data?.versions ?? []),
    [intentQuery.data?.versions],
  );
  const changes = useMemo(() => allChanges.filter(isMeaningful), [allChanges]);
  const currentVersion = allChanges.length;

  const hasSpec =
    intent !== undefined &&
    (intent.objective.length > 0 || intent.extended.length > 0);
  if (!hasSpec || !intent) return <div className="intent-panel" />;

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
            {intent.instructions.length > 0 && (
              <p>
                <strong>Agent instructions:</strong> {intent.instructions}
              </p>
            )}
            <p>
              <strong>Objective:</strong> {intent.objective || "(none stated)"}
            </p>
            {diverged && (
              <div className="intent-diverged" role="status">
                <p>
                  This objective came from the conversation and is not what the
                  agent's instructions say. The auditor judges against the
                  objective; the agent still reads its instructions.
                </p>
              </div>
            )}
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
                {change.isCurrent && (
                  <span className="intent-current-flag">in force</span>
                )}
              </div>

              {change.trigger && (
                <p className="intent-change-trigger">
                  From your message: &ldquo;{change.trigger}&rdquo;
                </p>
              )}
              {change.reason && (
                <p className="muted-cell">Classifier: {change.reason}</p>
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
    </div>
  );
}
