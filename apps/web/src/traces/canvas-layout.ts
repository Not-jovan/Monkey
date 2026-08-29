import type { TraceSpan } from "../types";
import {
  isSubagentBoundary,
  isSubagentTask,
  isVisibleStep,
  previewLabel,
  sortTime,
} from "./steps";

export const SLOT_WIDTH = 168;
export const SLOT_GAP = 52;
export const NODE_HEIGHT = 58;
export const ROW_GAP = 78;
export const TOP_PADDING = 46;
export const LEFT_PADDING = 40;
export const LABEL_GUTTER = 92;

export type EdgeKind = "sequential" | "delegate" | "return";

export interface CanvasLane {
  id: string;
  label: string;
  row: number;
}

export interface PlacedSpan {
  span: TraceSpan;
  laneId: string;
  row: number;
  column: number;
  x: number;
  y: number;
  centerY: number;
}

export interface CanvasEdge {
  kind: EdgeKind;
  from: PlacedSpan;
  to: PlacedSpan;
}

export interface CanvasLayout {
  steps: TraceSpan[];
  positions: PlacedSpan[];
  lanes: { row: number; label: string; y: number }[];
  edges: CanvasEdge[];
  contentWidth: number;
  height: number;
  maxRow: number;
}

export function parseSubagentIndex(span: TraceSpan) {
  const raw = span.attributes.subagentIndex;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function nearestBoundary(
  startId: string | null,
  spanById: Map<string, TraceSpan>,
) {
  let current = spanById.get(startId ?? "");
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isSubagentBoundary(current)) return current;
    current = spanById.get(current.parentId ?? "");
  }
  return null;
}

function callerLaneId(span: TraceSpan, spanById: Map<string, TraceSpan>) {
  const owner = nearestBoundary(span.parentId, spanById);
  if (owner) return owner.id;
  return "root";
}

export function laneIdForSpan(
  span: TraceSpan,
  spanById: Map<string, TraceSpan>,
) {
  if (span.actor === "user") return "user";

  const stamped = span.attributes.laneId;
  if (typeof stamped === "string" && stamped.length > 0) return stamped;

  if (span.name === "subagent.result") {
    const index = parseSubagentIndex(span);
    return "result:" + (span.parentId ?? span.id) + ":" + (index ?? span.id);
  }

  if (isSubagentTask(span)) {
    return callerLaneId(span, spanById);
  }

  const owner = nearestBoundary(span.parentId, spanById);
  if (owner) return owner.id;
  return "root";
}

function spawnLaneLabel(span: TraceSpan) {
  const type = span.attributes.subagentType;
  if (typeof type === "string" && type.length > 0) {
    return "sub · " + previewLabel(type, 22);
  }
  if (span.name === "subagent.result") {
    const index = parseSubagentIndex(span);
    if (index !== null) return "sub · " + index;
  }
  const toolName = span.attributes.toolName;
  if (typeof toolName === "string" && toolName.length > 0) {
    return "sub · " + toolName;
  }
  return "subagent";
}

function resultLaneLabel(laneId: string) {
  const parts = laneId.split(":");
  const index = parts[2];
  if (index && index.length > 0) return "sub · " + index;
  return "subagent";
}

export function orderedLaneIds(
  steps: TraceSpan[],
  spanById: Map<string, TraceSpan>,
) {
  const used = new Set(steps.map((span) => laneIdForSpan(span, spanById)));
  const lanes: CanvasLane[] = [];
  const placed = new Set<string>();

  const push = (id: string, label: string) => {
    if (!used.has(id) || placed.has(id)) return;
    placed.add(id);
    lanes.push({ id, label, row: lanes.length });
  };

  push("user", "user");
  push("root", "agent");
  push("auditor", "auditor");

  const spawns = steps
    .filter((span) => isSubagentTask(span))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  const visit = (spawn: TraceSpan) => {
    push(spawn.id, spawnLaneLabel(spawn));
    for (const laneId of used) {
      if (laneId.startsWith("result:" + spawn.id + ":")) {
        push(laneId, resultLaneLabel(laneId));
      }
    }
    for (const child of spawns) {
      if (child.parentId === spawn.id) visit(child);
    }
  };

  for (const spawn of spawns) {
    const caller = laneIdForSpan(spawn, spanById);
    if (caller === "root" || caller === "user") visit(spawn);
  }

  for (const laneId of used) {
    if (placed.has(laneId)) continue;
    if (laneId.startsWith("result:")) {
      push(laneId, resultLaneLabel(laneId));
      continue;
    }
    const spawn = spanById.get(laneId);
    push(laneId, spawn ? spawnLaneLabel(spawn) : "subagent");
  }

  return lanes;
}

function columnTime(span: TraceSpan, spanById: Map<string, TraceSpan>) {
  if (span.name === "subagent.result" && span.parentId) {
    const parent = spanById.get(span.parentId);
    if (parent) return sortTime(parent);
  }
  return sortTime(span);
}

function assignColumns(
  steps: TraceSpan[],
  laneOf: Map<string, string>,
  spanById: Map<string, TraceSpan>,
) {
  const times = [
    ...new Set(steps.map((span) => columnTime(span, spanById))),
  ].sort();
  const colByTime = new Map(times.map((time, index) => [time, index]));
  const occupied = new Map<string, Set<number>>();
  const columnOf = new Map<string, number>();
  for (const step of steps) {
    const laneId = laneOf.get(step.id) ?? "root";
    let column = colByTime.get(columnTime(step, spanById)) ?? 0;
    const used = occupied.get(laneId) ?? new Set<number>();
    while (used.has(column)) column += 1;
    used.add(column);
    occupied.set(laneId, used);
    columnOf.set(step.id, column);
  }
  return columnOf;
}

export function layoutSwimlanes(spans: TraceSpan[], minWidth = 0) {
  const spanById = new Map(spans.map((span) => [span.id, span]));
  const steps = spans
    .filter(isVisibleStep)
    .sort((left, right) => sortTime(left).localeCompare(sortTime(right)));
  const laneOf = new Map(
    steps.map((span) => [span.id, laneIdForSpan(span, spanById)]),
  );
  const laneDefs = orderedLaneIds(steps, spanById);
  const rowByLane = new Map(laneDefs.map((lane) => [lane.id, lane.row]));
  const columnOf = assignColumns(steps, laneOf, spanById);

  const positions: PlacedSpan[] = steps.map((span) => {
    const laneId = laneOf.get(span.id) ?? "root";
    const row = rowByLane.get(laneId) ?? 0;
    const column = columnOf.get(span.id) ?? 0;
    const y = TOP_PADDING + row * ROW_GAP;
    return {
      span,
      laneId,
      row,
      column,
      x: LABEL_GUTTER + LEFT_PADDING + column * (SLOT_WIDTH + SLOT_GAP),
      y,
      centerY: y + NODE_HEIGHT / 2,
    };
  });

  let contentWidth = Math.max(
    minWidth,
    LABEL_GUTTER + LEFT_PADDING + SLOT_WIDTH,
  );
  for (const position of positions) {
    const right = position.x + SLOT_WIDTH + LEFT_PADDING;
    if (right > contentWidth) contentWidth = right;
  }

  const lanes: CanvasLayout["lanes"] = laneDefs.map((lane) => ({
    row: lane.row,
    label: lane.label,
    y: TOP_PADDING + lane.row * ROW_GAP,
  }));

  const edges: CanvasEdge[] = [];
  const linked = new Set<string>();
  const pushEdge = (kind: EdgeKind, from: PlacedSpan, to: PlacedSpan) => {
    const key = kind + ":" + from.span.id + "->" + to.span.id;
    if (linked.has(key)) return;
    linked.add(key);
    edges.push({ kind, from, to });
  };

  const byLane = new Map<string, PlacedSpan[]>();
  for (const position of positions) {
    const list = byLane.get(position.laneId) ?? [];
    list.push(position);
    byLane.set(position.laneId, list);
  }
  for (const list of byLane.values()) {
    list.sort((left, right) =>
      sortTime(left.span).localeCompare(sortTime(right.span)),
    );
    for (let index = 0; index + 1 < list.length; index += 1) {
      pushEdge("sequential", list[index]!, list[index + 1]!);
    }
  }

  const userSteps = positions.filter((position) => position.laneId === "user");
  const rootSteps = (byLane.get("root") ?? []).sort((left, right) =>
    sortTime(left.span).localeCompare(sortTime(right.span)),
  );
  if (userSteps[0] && rootSteps[0]) {
    pushEdge("sequential", userSteps[0], rootSteps[0]);
  }

  for (const current of positions) {
    if (!isSubagentTask(current.span)) {
      continue;
    }
    const children = positions
      .filter(
        (position) =>
          position.span.parentId === current.span.id &&
          position.row !== current.row,
      )
      .sort((left, right) =>
        sortTime(left.span).localeCompare(sortTime(right.span)),
      );
    const seenChildLanes = new Set<string>();
    for (const child of children) {
      if (seenChildLanes.has(child.laneId)) continue;
      seenChildLanes.add(child.laneId);
      pushEdge("delegate", current, child);
    }

    if (current.span.status === "running") continue;
    for (const laneId of seenChildLanes) {
      const onLane = children.filter((child) => child.laneId === laneId);
      const last = onLane[onLane.length - 1];
      if (!last) continue;
      if (last.column === current.column) continue;
      pushEdge("return", last, current);
    }
  }

  return {
    steps,
    positions,
    lanes,
    edges,
    contentWidth,
    height: TOP_PADDING + Math.max(1, laneDefs.length) * ROW_GAP + 24,
    maxRow: laneDefs.length === 0 ? 0 : laneDefs.length - 1,
  };
}
