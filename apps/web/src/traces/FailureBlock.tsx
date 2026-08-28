import { useMemo, useState } from "react";
import type { CodexFailure } from "./codex-error";

// A failed tool call, arranged so the diagnosis is the first thing read:
// what failed, then what went wrong, then the runtime facts, then the stack.
//
// The Raw toggle is not a debug affordance. The problem this whole feature
// exists to solve is that a Codex failure arrives as a single escaped line —
// measured at just over 4,000 characters on a real sandbox denial, a third of
// it the same payload repeated across message, stderr and aggregated_output.
// Being able to put that next to the diagnosis, in one screen, is what makes
// the improvement legible instead of merely claimed.

export function FailureBlock({
  failure,
  raw,
}: {
  failure: CodexFailure;
  raw: string;
}) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"diagnosed" | "raw">("diagnosed");

  const summary = useMemo(() => {
    const parts = [failure.tool, failure.kind].filter(Boolean);
    return parts.join(" · ") || "Tool call failed";
  }, [failure]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard can be denied; the raw section below is still selectable.
    }
  };

  return (
    <div className="failure-block">
      <div className="failure-head">
        <span className="failure-kind">{summary}</span>
        {failure.exitCode !== null && (
          <span className="failure-exit">exit {failure.exitCode}</span>
        )}
        <div className="view-toggle" role="group" aria-label="Failure detail">
          <button
            type="button"
            className={view === "diagnosed" ? "is-active" : ""}
            aria-pressed={view === "diagnosed"}
            onClick={() => setView("diagnosed")}
          >
            Diagnosed
          </button>
          <button
            type="button"
            className={view === "raw" ? "is-active" : ""}
            aria-pressed={view === "raw"}
            onClick={() => setView("raw")}
          >
            Raw
          </button>
        </div>
        <button type="button" className="text-block-action" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy raw"}
        </button>
      </div>

      {view === "raw" && (
        <div className="failure-raw-view">
          <p className="failure-raw-note">
            What the Runtime actually reported: {raw.length.toLocaleString()}{" "}
            characters on one line, before any of the structure above was
            recovered from it.
          </p>
          <pre>{raw}</pre>
        </div>
      )}

      {view === "diagnosed" && failure.problems.length > 0 && (
        <ul className="failure-problems">
          {failure.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {view === "diagnosed" && failure.facts.length > 0 && (
        <p className="failure-facts">
          {failure.facts.map((fact, index) => (
            <span key={fact.label}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              {fact.label} <strong>{fact.value}</strong>
            </span>
          ))}
        </p>
      )}

      {view === "diagnosed" && failure.stack.length > 0 && (
        <details className="failure-details">
          <summary>Stack trace ({failure.stack.length} frames)</summary>
          <pre>{failure.stack.join("\n")}</pre>
        </details>
      )}

      {view === "diagnosed" && failure.rest.trim().length > 0 && (
        <details className="failure-details">
          <summary>Other output</summary>
          <pre>{failure.rest}</pre>
        </details>
      )}


    </div>
  );
}
