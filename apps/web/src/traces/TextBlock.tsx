import { useMemo, useState } from "react";
import { parseToolOutput, readClipNotice } from "./tool-output";

// A block of trace text: Codex's preamble lifted into a metadata row, a
// collapsed body that expands in full rather than trapping the text in a
// fixed-height scroller, and a copy button.

const COLLAPSED_LINES = 14;

export function TextBlock({
  label,
  text,
  note,
}: {
  label: string;
  text: string;
  note?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const { meta, body, clippedChars } = useMemo(() => {
    const parsed = parseToolOutput(text);
    const clip = readClipNotice(parsed.body);
    return {
      meta: parsed.meta,
      body: clip ? clip.body : parsed.body,
      clippedChars: clip ? clip.hiddenChars : 0,
    };
  }, [text]);

  const lines = useMemo(() => body.split(/\r?\n/), [body]);
  const overflows = lines.length > COLLAPSED_LINES;
  const shown =
    expanded || !overflows ? body : lines.slice(0, COLLAPSED_LINES).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be denied; the text is selectable either way.
    }
  };

  return (
    <div className="span-context-block">
      <div className="text-block-head">
        <span className="eyebrow">{label}</span>
        {meta.map((entry) => (
          <span className="text-block-meta" key={entry.label}>
            {entry.label} <strong>{entry.value}</strong>
          </span>
        ))}
        <button type="button" className="text-block-action" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
          <span className="sr-only"> {label}</span>
        </button>
      </div>
      {note && <p className="muted-cell">{note}</p>}
      <pre
        className={
          (overflows ? "is-toggleable" : "") +
          (overflows && !expanded ? " is-collapsed" : "")
        }
        onClick={
          overflows
            ? () => {
                // The body toggles, but a click that ends a text selection must
                // select rather than collapse — otherwise copying from a long
                // output would close it mid-drag.
                const selection = window.getSelection();
                if (selection && !selection.isCollapsed) return;
                setExpanded((value) => !value);
              }
            : undefined
        }
      >
        {shown}
      </pre>
      {overflows && (
        <button
          type="button"
          className="text-block-action text-block-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Show less"
            : "Show all " + lines.length + " lines"}
        </button>
      )}
      {clippedChars > 0 && (
        <p className="muted-cell">
          The collector stored only the first part of this value;{" "}
          {clippedChars.toLocaleString()} more characters were not kept.
        </p>
      )}
    </div>
  );
}
