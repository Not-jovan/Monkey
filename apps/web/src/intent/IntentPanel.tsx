import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { IntentState, IntentUpdate } from "../types";

// The specification the auditor judges this agent's actions against, plus any
// change it detected that is waiting on the user. Classification happens just
// after a message is sent, so a proposal appears a beat later rather than
// blocking the send.
export function IntentPanel({
  agentId,
  refreshKey,
}: {
  agentId: string;
  refreshKey: number;
}) {
  const [intent, setIntent] = useState<IntentState | null>(null);
  const [pending, setPending] = useState<IntentUpdate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.intent(agentId);
      if (!mounted.current) return;
      setIntent(data.intent);
      setPending(data.pending);
    } catch {
      // The panel is informational; a failed poll should not disturb the chat.
    }
  }, [agentId]);

  useEffect(() => {
    void load();
    // A proposal lands shortly after a message, so poll briefly rather than
    // making the user reload to see it.
    const timer = setInterval(() => void load(), 4_000);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  const decide = async (updateId: string, decision: "confirm" | "reject") => {
    setBusyId(updateId);
    try {
      const data = await api.resolveIntent(agentId, updateId, decision);
      if (!mounted.current) return;
      setIntent(data.intent);
      setPending(data.pending);
    } catch {
      void load();
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const hasSpec =
    intent !== null &&
    (intent.objective.length > 0 || intent.extended.length > 0);

  // The wrapper renders even when empty: the playground is a fixed-row grid,
  // and a child that comes and goes would shift every row beneath it.
  return (
    <div className="intent-panel">
      {pending.map((update) => (
        <div className="intent-proposal" key={update.id}>
          <div className="intent-proposal-body">
            <span className="eyebrow">Update your Agent&rsquo;s intent?</span>
            <p className="muted-cell">
              From &ldquo;{update.message}&rdquo;
            </p>
            {update.objectiveAfter && (
              <p>
                <strong>New objective:</strong> {update.objectiveAfter}
              </p>
            )}
            {update.added.length > 0 && (
              <ul>
                {update.added.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="intent-proposal-actions">
            <button
              className="primary"
              disabled={busyId === update.id}
              onClick={() => void decide(update.id, "confirm")}
            >
              Confirm
            </button>
            <button
              disabled={busyId === update.id}
              onClick={() => void decide(update.id, "reject")}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}

      {hasSpec && (
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
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
          {expanded && (
            <div className="intent-detail">
              <p>
                <strong>Objective:</strong>{" "}
                {intent.objective || "(none stated)"}
              </p>
              {intent.extended.length > 0 && (
                <ul>
                  {intent.extended.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
