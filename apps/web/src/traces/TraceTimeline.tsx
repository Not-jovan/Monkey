import type { TraceSpan } from "../types";
import { formatDuration, spanDuration } from "./format";
import { isErrorStep, stepHeadline } from "./steps";
import { layoutTimeline, timelineTickLabels } from "./timeline-layout";

interface TraceTimelineProps {
  spans: TraceSpan[];
  selectedId: string | null;
  failingSpanId: string | null;
  warningsBySpan: Map<string, number>;
  onSelect: (spanId: string) => void;
}

export function TraceTimeline({
  spans,
  selectedId,
  failingSpanId,
  warningsBySpan,
  onSelect,
}: TraceTimelineProps) {
  const layout = layoutTimeline(spans, Date.now());
  const ticks = timelineTickLabels(layout);

  if (layout.steps.length === 0) {
    return (
      <div className="trace-timeline-empty">Waiting for the first step…</div>
    );
  }

  return (
    <div className="trace-timeline">
      <div className="trace-timeline-axis" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span key={index + "-" + tick}>{tick}</span>
        ))}
      </div>
      {layout.lanes.map((lane) => {
        const bars = layout.bars.filter((bar) => bar.laneId === lane.id);
        return (
          <div className="trace-timeline-row" key={lane.id}>
            <div className="trace-timeline-lane">{lane.label}</div>
            <div
              className="trace-timeline-track"
              style={{
                height: (layout.stacksByLane.get(lane.id) ?? 1) * 32 + 8,
              }}
            >
              {bars.map((bar) => {
                const warnings = warningsBySpan.get(bar.span.id) ?? 0;
                const selected = bar.span.id === selectedId;
                const failing = bar.span.id === failingSpanId;
                const errored = isErrorStep(bar.span);
                const duration =
                  bar.span.durationMs ??
                  spanDuration(bar.span.startedAt, bar.span.endedAt);
                let className = "trace-timeline-bar";
                if (selected) className += " is-selected";
                if (failing || errored) className += " is-failing";
                if (bar.span.status === "running") className += " is-running";
                return (
                  <button
                    type="button"
                    key={bar.span.id}
                    className={className}
                    style={{
                      left: bar.left * 100 + "%",
                      width: bar.width * 100 + "%",
                      top: 4 + bar.stack * 32,
                    }}
                    aria-pressed={selected}
                    title={stepHeadline(bar.span)}
                    onClick={() => onSelect(bar.span.id)}
                  >
                    <span className="trace-timeline-bar-label">
                      {stepHeadline(bar.span)}
                    </span>
                    <span className="trace-timeline-bar-meta">
                      {formatDuration(duration)}
                      {warnings > 0 ? " · " + warnings : ""}
                    </span>
                    {warnings > 0 && (
                      <span className="sr-only">
                        , {warnings} audit warning{warnings > 1 ? "s" : ""}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
