import type { TraceSpan } from "../types";
import { orderedLaneIds, laneIdForSpan } from "./canvas-layout";
import { formatDuration } from "./format";
import { isVisibleStep, sortTime } from "./steps";

export interface TimelineBar {
  span: TraceSpan;
  laneId: string;
  row: number;
  stack: number;
  left: number;
  width: number;
  startMs: number;
  endMs: number;
}

export interface TimelineLayout {
  steps: TraceSpan[];
  lanes: { id: string; label: string; row: number }[];
  bars: TimelineBar[];
  stacksByLane: Map<string, number>;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export function layoutTimeline(spans: TraceSpan[], nowMs: number) {
  const spanById = new Map(spans.map((span) => [span.id, span]));
  const steps = spans
    .filter(isVisibleStep)
    .sort((left, right) => sortTime(left).localeCompare(sortTime(right)));
  const lanes = orderedLaneIds(steps, spanById);
  const rowByLane = new Map(lanes.map((lane) => [lane.id, lane.row]));

  if (steps.length === 0) {
    return {
      steps,
      lanes,
      bars: [],
      stacksByLane: new Map(),
      startedAt: nowMs,
      endedAt: nowMs,
      durationMs: 0,
    };
  }

  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = 0;
  const ranges = steps.map((span) => {
    const start = new Date(span.startedAt).getTime();
    const recordedEnd = span.endedAt
      ? new Date(span.endedAt).getTime()
      : nowMs;
    const end = Math.max(recordedEnd, start);
    if (start < startedAt) startedAt = start;
    if (end > endedAt) endedAt = end;
    return { span, start, end };
  });

  const durationMs = Math.max(endedAt - startedAt, 1);

  const bars: TimelineBar[] = ranges.map(({ span, start, end }) => {
    const laneId = laneIdForSpan(span, spanById);
    const left = (start - startedAt) / durationMs;
    const width = Math.min((end - start) / durationMs, 1 - left);
    return {
      span,
      laneId,
      row: rowByLane.get(laneId) ?? 0,
      stack: 0,
      left,
      width,
      startMs: start,
      endMs: end,
    };
  });

  const stacksByLane = packStacks(bars);

  return {
    steps,
    lanes,
    bars,
    stacksByLane,
    startedAt,
    endedAt,
    durationMs,
  };
}

// Stack only when wall-clock ranges overlap. Visual min-width is a canvas
// concern and must not invent concurrency for sequential steps.
function packStacks(bars: TimelineBar[]) {
  const stacksByLane = new Map<string, number>();
  const byLane = new Map<string, TimelineBar[]>();
  for (const bar of bars) {
    const list = byLane.get(bar.laneId) ?? [];
    list.push(bar);
    byLane.set(bar.laneId, list);
  }
  for (const [laneId, list] of byLane) {
    list.sort((left, right) => left.startMs - right.startMs);
    const rowEnds: number[] = [];
    for (const bar of list) {
      let stack = 0;
      while (stack < rowEnds.length && rowEnds[stack]! > bar.startMs) {
        stack += 1;
      }
      bar.stack = stack;
      if (stack === rowEnds.length) rowEnds.push(bar.endMs);
      else rowEnds[stack] = bar.endMs;
    }
    stacksByLane.set(laneId, Math.max(1, rowEnds.length));
  }
  return stacksByLane;
}

export function timelineTickLabels(layout: TimelineLayout) {
  if (layout.durationMs <= 0) return ["0", formatDuration(0)];
  return ["0", formatDuration(layout.durationMs / 2), formatDuration(layout.durationMs)];
}

export const MIN_TIMELINE_ZOOM = 1;
export const MAX_TIMELINE_ZOOM = 48;

export function timelineContentWidth(viewWidth: number, zoom: number) {
  return Math.max(viewWidth, viewWidth * zoom);
}

export function clampTimelinePan(
  panX: number,
  viewWidth: number,
  contentWidth: number,
) {
  const minX = Math.min(0, viewWidth - contentWidth);
  return Math.max(minX, Math.min(0, panX));
}

export function zoomTimeline(input: {
  zoom: number;
  panX: number;
  viewWidth: number;
  pointerX: number;
  factor: number;
}) {
  const nextZoom = Math.min(
    MAX_TIMELINE_ZOOM,
    Math.max(MIN_TIMELINE_ZOOM, input.zoom * input.factor),
  );
  const content = timelineContentWidth(input.viewWidth, input.zoom);
  const nextContent = timelineContentWidth(input.viewWidth, nextZoom);
  const ratio = content <= 0 ? 0 : (input.pointerX - input.panX) / content;
  return {
    zoom: nextZoom,
    panX: clampTimelinePan(
      input.pointerX - ratio * nextContent,
      input.viewWidth,
      nextContent,
    ),
  };
}

export function visibleTimelineTicks(
  layout: TimelineLayout,
  panX: number,
  viewWidth: number,
  contentWidth: number,
) {
  if (layout.durationMs <= 0 || contentWidth <= 0) {
    return timelineTickLabels(layout);
  }
  const startOffset = (-panX / contentWidth) * layout.durationMs;
  const endOffset = ((-panX + viewWidth) / contentWidth) * layout.durationMs;
  return [
    formatDuration(Math.max(0, startOffset)),
    formatDuration(Math.max(0, (startOffset + endOffset) / 2)),
    formatDuration(Math.max(0, endOffset)),
  ];
}
