import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceSpan } from "../types";
import { formatDuration, formatTime, displaySpanDurationMs } from "./format";
import { orderedSteps, stepHeadline, stepRole, stepStatusText } from "./steps";

// The default view of a run: real DOM, so it is keyboard navigable, readable
// by a screen reader, selectable, and findable with the browser's own search —
// none of which the canvas flow can offer, because Konva paints into a bitmap.
//
// Follows the listbox pattern: one tab stop for the whole list, arrows move
// between steps, and selection follows focus because selecting only changes
// which step the detail panel describes.

interface TraceStepListProps {
  spans: TraceSpan[];
  selectedId: string | null;
  failingSpanId: string | null;
  warningsBySpan: Map<string, number>;
  onSelect: (spanId: string) => void;
}

export function TraceStepList({
  spans,
  selectedId,
  failingSpanId,
  warningsBySpan,
  onSelect,
}: TraceStepListProps) {
  const steps = useMemo(() => orderedSteps(spans), [spans]);
  const listRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const selectedIndex = steps.findIndex((step) => step.span.id === selectedId);

  // Keep the roving tab stop on whatever is actually selected, including when
  // selection changes from outside the list.
  useEffect(() => {
    if (selectedIndex >= 0) setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  const focusStep = (index: number) => {
    const clamped = Math.max(0, Math.min(index, steps.length - 1));
    const step = steps[clamped];
    if (!step) return;
    setActiveIndex(clamped);
    onSelect(step.span.id);
    listRef.current
      ?.querySelector<HTMLElement>('[data-index="' + clamped + '"]')
      ?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const handlers: Record<string, () => void> = {
      ArrowDown: () => focusStep(activeIndex + 1),
      ArrowUp: () => focusStep(activeIndex - 1),
      Home: () => focusStep(0),
      End: () => focusStep(steps.length - 1),
      PageDown: () => focusStep(activeIndex + 10),
      PageUp: () => focusStep(activeIndex - 10),
    };
    const handler = handlers[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  if (steps.length === 0) {
    return (
      <div className="step-list-empty">No steps recorded for this run yet.</div>
    );
  }

  return (
    <div
      className="step-list"
      ref={listRef}
      role="listbox"
      aria-label={"Run steps, " + steps.length + " total"}
      onKeyDown={onKeyDown}
    >
      {steps.map(({ span, depth }, index) => {
        const warnings = warningsBySpan.get(span.id) ?? 0;
        const duration = displaySpanDurationMs(span, spans);
        const failing = span.id === failingSpanId;
        const selected = span.id === selectedId;
        return (
          <div
            key={span.id}
            data-index={index}
            role="option"
            aria-selected={selected}
            tabIndex={index === activeIndex ? 0 : -1}
            className={
              "step-row" +
              (selected ? " step-row-selected" : "") +
              (failing ? " step-row-failing" : "") +
              " step-status-" +
              span.status
            }
            style={{ paddingLeft: 12 + depth * 20 }}
            onClick={() => {
              setActiveIndex(index);
              onSelect(span.id);
            }}
          >
            <span className="step-ordinal" aria-hidden="true">
              {index + 1}
            </span>
            <span className={"step-dot step-dot-" + span.status} aria-hidden="true" />
            <span className="step-role">{stepRole(span)}</span>
            <span className="step-label">{stepHeadline(span)}</span>
            {/* Conveyed visually by the dot and the row tint; said out loud here. */}
            <span className="sr-only">, {stepStatusText(span)}</span>
            {failing && <span className="step-flag">failed here</span>}
            {warnings > 0 && (
              <span className="warning-badge">
                ⚠ {warnings}
                <span className="sr-only">
                  {" "}
                  audit warning{warnings > 1 ? "s" : ""}
                </span>
              </span>
            )}
            <span className="step-time" aria-hidden="true">
              {formatTime(span.startedAt)}
            </span>
            <span className="step-duration">
              {formatDuration(duration)}
              <span className="sr-only"> duration</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
