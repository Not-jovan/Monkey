import type { TraceSpan } from "../types";
import { orderedLaneIds, laneIdForSpan } from "./canvas-layout";
import { formatDuration } from "./format";
import { isVisibleStep, sortTime } from "./steps";

// A zero-width bar is unclickable; keep a sliver so short steps still register.
const MIN_BAR_RATIO = 0.012;

export interface TimelineBar {
  span: TraceSpan;
  laneId: string;
  row: number;
  stack: number;
  left: number;
  width: number;
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
    const rawWidth = (end - start) / durationMs;
    const width = Math.min(Math.max(rawWidth, MIN_BAR_RATIO), 1 - left);
    return {
      span,
      laneId,
      row: rowByLane.get(laneId) ?? 0,
      stack: 0,
      left,
      width,
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

function packStacks(bars: TimelineBar[]) {
  const stacksByLane = new Map<string, number>();
  const byLane = new Map<string, TimelineBar[]>();
  for (const bar of bars) {
    const list = byLane.get(bar.laneId) ?? [];
    list.push(bar);
    byLane.set(bar.laneId, list);
  }
  for (const [laneId, list] of byLane) {
    list.sort((left, right) => left.left - right.left);
    const rowEnds: number[] = [];
    for (const bar of list) {
      const right = bar.left + bar.width;
      let stack = 0;
      while (stack < rowEnds.length && rowEnds[stack]! > bar.left + 0.001) {
        stack += 1;
      }
      bar.stack = stack;
      if (stack === rowEnds.length) rowEnds.push(right);
      else rowEnds[stack] = right;
    }
    stacksByLane.set(laneId, Math.max(1, rowEnds.length));
  }
  return stacksByLane;
}

export function timelineTickLabels(layout: TimelineLayout) {
  if (layout.durationMs <= 0) return ["0", formatDuration(0)];
  return ["0", formatDuration(layout.durationMs / 2), formatDuration(layout.durationMs)];
}
