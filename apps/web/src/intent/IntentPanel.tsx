import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { IntentState } from "../types";

export function IntentPanel({ agentId }: { agentId: string }) {
  const [expanded, setExpanded] = useState(false);
  const intentQuery = useQuery({
    queryKey: ["intent", agentId],
    queryFn: () => api.intent(agentId),
    refetchInterval: 4_000,
  });
  const intent: IntentState | undefined = intentQuery.data?.intent;
  const hasSpec =
    intent !== undefined &&
    (intent.objective.length > 0 || intent.extended.length > 0);

  return (
    <div className="intent-panel">
      {hasSpec && intent && (
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
