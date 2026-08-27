import { useMemo, useState } from "react";
import type { CodexFailure } from "./codex-error";

// A failed tool call, arranged so the diagnosis is the first thing read:
// what failed, then what went wrong, then the runtime facts, then the stack.
// The raw envelope stays one click away — it is the evidence, and hiding it
// entirely would trade one problem for another.

export function FailureBlock({
  failure,
  raw,
}: {
  failure: CodexFailure;
  raw: string;
}) {
  const [copied, setCopied] = useState(false);

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
        <button type="button" className="text-block-action" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy raw"}
        </button>
      </div>

      {failure.problems.length > 0 && (
        <ul className="failure-problems">
          {failure.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {failure.facts.length > 0 && (
        <p className="failure-facts">
          {failure.facts.map((fact, index) => (
            <span key={fact.label}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              {fact.label} <strong>{fact.value}</strong>
            </span>
          ))}
        </p>
      )}

      {failure.stack.length > 0 && (
        <details className="failure-details">
          <summary>Stack trace ({failure.stack.length} frames)</summary>
          <pre>{failure.stack.join("\n")}</pre>
        </details>
      )}

      {failure.rest.trim().length > 0 && (
        <details className="failure-details">
          <summary>Other output</summary>
          <pre>{failure.rest}</pre>
        </details>
      )}

      <details className="failure-details">
        <summary>Raw envelope ({raw.length.toLocaleString()} chars)</summary>
        <pre>{raw}</pre>
      </details>
    </div>
  );
}
