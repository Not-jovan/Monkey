import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Arrow, Circle, Group, Layer, Line, Rect, Stage, Text } from "react-konva";
import type { SpanKind, TraceSpan } from "../types";
import { formatDuration, spanDuration } from "./format";

const SLOT_WIDTH = 190;
const SLOT_GAP = 80;
const NODE_HEIGHT = 62;
const ROW_GAP = 96;
const EDGE_LABEL_GAP = 18;
const TOP_PADDING = 46;
const LEFT_PADDING = 40;
const LABEL_GUTTER = 92;

const VISIBLE_KINDS = new Set<SpanKind>([
  "user_action",
  "tool_call",
  "model_call",
  "system",
]);

const COLORS = {
  ink: "#20211f",
  muted: "#777870",
  paper: "#fbfaf7",
  line: "#deddd6",
  purple: "#6954d9",
  green: "#33906d",
  red: "#c55353",
  amber: "#b98a2c",
  warning: "#d97706",
};

function statusColor(span: TraceSpan) {
  if (span.status === "error") return COLORS.red;
  if (span.status === "running") return COLORS.amber;
  return COLORS.green;
}

function isSubagentToolName(toolName: string) {
  const normalized = toolName.toLowerCase();
  if (normalized === "task") return true;
  if (normalized === "spawn_agent") return true;
  if (normalized.endsWith("/spawn_agent")) return true;
  return false;
}

function isSubagentTask(span: TraceSpan) {
  if (span.attributes.subagent === true) return true;
  if (span.kind !== "tool_call") return false;
  const toolName = span.attributes.toolName;
  if (typeof toolName === "string" && isSubagentToolName(toolName)) {
    return true;
  }
  const normalizedName = span.name.toLowerCase();
  if (normalizedName === "tool.task") return true;
  if (normalizedName === "tool.spawn_agent") return true;
  return normalizedName.endsWith(".spawn_agent");
}

function isSubagentBoundary(span: TraceSpan) {
  if (isSubagentTask(span)) return true;
  if (span.attributes.spawnsSubagents === true) return true;
  return false;
}

function ownContentDepth(span: TraceSpan, spanById: Map<string, TraceSpan>) {
  let depth = 0;
  let current: TraceSpan | undefined = span;
  while (current?.parentId) {
    const parent = spanById.get(current.parentId);
    if (!parent) break;
    if (isSubagentBoundary(parent)) depth += 1;
    current = parent;
  }
  return depth;
}

function parentContentDepth(
  parentId: string | null,
  spanById: Map<string, TraceSpan>,
) {
  if (!parentId) return 0;
  const parent = spanById.get(parentId);
  if (!parent) return 0;
  return ownContentDepth(parent, spanById);
}

function contentTrackDepth(span: TraceSpan, spanById: Map<string, TraceSpan>) {
  if (isSubagentTask(span)) {
    return parentContentDepth(span.parentId, spanById);
  }
  if (span.attributes.spawnsSubagents === true) {
    return parentContentDepth(span.parentId, spanById);
  }
  return ownContentDepth(span, spanById);
}

function parseSubagentIndex(span: TraceSpan): number | null {
  const raw = span.attributes.subagentIndex;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function maxSubagentLanes(steps: TraceSpan[]) {
  let max = 0;
  for (const span of steps) {
    if (span.name !== "subagent.result") continue;
    const index = parseSubagentIndex(span);
    if (index !== null && index + 1 > max) max = index + 1;
  }
  return max;
}

function rowIndex(
  span: TraceSpan,
  spanById: Map<string, TraceSpan>,
  maxSubagentLanes: number,
  maxContentDepth: number,
) {
  const bottomRow = 2 + Math.max(maxSubagentLanes, maxContentDepth);
  if (span.name === "user.prompt") return 0;
  if (span.name === "user.intervention") return bottomRow;
  if (span.actor === "user") return 0;

  const subIndex = parseSubagentIndex(span);
  if (span.name === "subagent.result" && subIndex !== null) {
    return 2 + subIndex;
  }

  return 1 + contentTrackDepth(span, spanById);
}

function rowY(row: number) {
  return TOP_PADDING + row * ROW_GAP;
}

function trackLabel(
  row: number,
  steps: TraceSpan[],
  spanById: Map<string, TraceSpan>,
  maxSubagentLanes: number,
  maxContentDepth: number,
) {
  if (row === 0) return "user";
  if (row === 1) return "agent";
  const bottomRow = 2 + Math.max(maxSubagentLanes, maxContentDepth);
  if (row === bottomRow && spanById.size > 0) {
    const hasIntervention = steps.some((span) => span.name === "user.intervention");
    if (hasIntervention) return "user";
  }
  if (maxSubagentLanes > 0 && row >= 2 && row < 2 + maxSubagentLanes) {
    return "sub · " + (row - 2);
  }
  const depth = row - 1;
  if (depth === 0) return "agent";
  const laneSpan = steps.find(
    (span) =>
      rowIndex(span, spanById, maxSubagentLanes, maxContentDepth) === row &&
      (span.name === "subagent.result" || isSubagentTask(span)),
  );
  const subagentType = laneSpan?.attributes.subagentType;
  if (typeof subagentType === "string" && subagentType.length > 0) {
    return "sub · " + subagentType;
  }
  if (depth === 1) return "subagent";
  return "subagent L" + depth;
}

function stepLabel(span: TraceSpan) {
  if (span.kind === "model_call") return span.label;

  if (span.name === "subagent.result") {
    const index = span.attributes.subagentIndex;
    const indexLabel =
      typeof index === "string" || typeof index === "number" ? String(index) : "?";
    return "Subagent · " + indexLabel + " · returned";
  }

  if (span.kind === "tool_call") {
    const toolName =
      typeof span.attributes.toolName === "string"
        ? span.attributes.toolName
        : span.name.replace(/^tool\./, "");
    if (span.attributes.spawnsSubagents === true) {
      const count = span.attributes.subagentCount;
      if (typeof count === "number" || typeof count === "string") {
        return "Tool · " + toolName + " · spawns ×" + count;
      }
      return "Tool · " + toolName + " · spawns subagents";
    }
    if (isSubagentTask(span)) {
      if (span.label.startsWith("Subagent")) return span.label;
      const type = span.attributes.subagentType;
      if (typeof type === "string" && type.length > 0) {
        return "Subagent · " + type;
      }
      return "Subagent · task";
    }
    if (span.label.startsWith("Tool ·")) return span.label;
    if (span.label.startsWith("Called ")) {
      return "Tool · " + span.label.slice("Called ".length);
    }
    return "Tool · " + toolName;
  }

  return span.label;
}

type EdgeKind = "sequential" | "delegate" | "return";

function edgeLabel(
  kind: EdgeKind,
  from: TraceSpan,
  fromRow: number,
  toRow: number,
  gapMs: number,
) {
  if (kind === "return") {
    const subagentIndex = from.attributes.subagentIndex;
    if (typeof subagentIndex === "string" || typeof subagentIndex === "number") {
      return "result · " + subagentIndex;
    }
    return "result";
  }
  if (from.actor === "user") {
    if (from.name === "user.intervention") return 'User "Terminated"';
    return 'User "Prompt"';
  }
  if (
    kind === "delegate" &&
    toRow > fromRow &&
    (isSubagentTask(from) || from.attributes.spawnsSubagents === true)
  ) {
    const subagentType = from.attributes.subagentType;
    if (typeof subagentType === "string" && subagentType.length > 0) {
      return subagentType;
    }
    return "delegate";
  }
  return formatDuration(Math.max(gapMs, 0));
}

function edgeStroke(
  selectedId: string | null,
  fromSpanId: string,
  toSpanId: string,
  kind: EdgeKind,
) {
  if (!selectedId) return COLORS.line;
  if (kind === "return") {
    return selectedId === fromSpanId ? COLORS.purple : COLORS.line;
  }
  if (kind === "delegate") {
    return selectedId === fromSpanId || selectedId === toSpanId
      ? COLORS.purple
      : COLORS.line;
  }
  return selectedId === fromSpanId || selectedId === toSpanId
    ? COLORS.purple
    : COLORS.line;
}

function edgeBendOffset(
  kind: EdgeKind,
  from: { span: TraceSpan },
  to: { span: TraceSpan },
) {
  const indexedSpan = kind === "return" ? from.span : to.span;
  const index = parseSubagentIndex(indexedSpan);
  if (index !== null) return 48 + index * 40;
  return 52;
}

function connectionPoint(
  position: {
    span: TraceSpan;
    x: number;
    y: number;
    centerY: number;
  },
  side: "from" | "to",
  kind: EdgeKind,
) {
  const { span, x, y, centerY } = position;
  const circleRadius = 26;
  if (span.actor === "user") {
    const cx = x + SLOT_WIDTH / 2;
    if (side === "from") {
      return { x: cx + circleRadius, y: centerY };
    }
    return { x: cx, y: centerY };
  }
  if (side === "from") {
    return { x: x + SLOT_WIDTH - 8, y: centerY };
  }
  if (kind === "return") {
    return { x: x + SLOT_WIDTH - 8, y: y + NODE_HEIGHT - 4 };
  }
  return { x: x + 6, y: centerY };
}

function edgeBend(fromX: number, toX: number, offset: number) {
  if (toX >= fromX) return fromX + offset;
  return fromX - offset;
}

function edgePoints(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  bendOffset = 36,
) {
  if (Math.abs(fromY - toY) < 1) {
    return [fromX, fromY, toX, toY];
  }
  const elbowX = edgeBend(fromX, toX, bendOffset);
  return [fromX, fromY, elbowX, fromY, elbowX, toY, toX, toY];
}

function edgeLabelLayout(
  kind: EdgeKind,
  label: string,
  fromSpan: TraceSpan,
  toSpan: TraceSpan,
  points: number[],
) {
  const width = Math.max(72, label.length * 6.5);
  const height = 18;

  if (points.length === 4) {
    const midX = (points[0]! + points[2]!) / 2;
    const midY = (points[1]! + points[3]!) / 2;
    return {
      x: midX - width / 2,
      y: midY - height / 2 - EDGE_LABEL_GAP,
      width,
      height,
    };
  }

  if (points.length >= 8) {
    const elbowX = points[4]!;
    const fromY = points[1]!;
    const toY = points[5]!;
    const midY = (fromY + toY) / 2;
    const indexedSpan = kind === "return" ? fromSpan : toSpan;
    const index = parseSubagentIndex(indexedSpan) ?? 0;
    const side = index % 2 === 0 ? 1 : -1;
    return {
      x: elbowX + side * EDGE_LABEL_GAP - width / 2,
      y: midY - height / 2,
      width,
      height,
    };
  }

  const midX = (points[0]! + points.at(-2)!) / 2;
  const midY = (points[1]! + points.at(-1)!) / 2;
  return {
    x: midX - width / 2,
    y: midY - height / 2 - EDGE_LABEL_GAP,
    width,
    height,
  };
}

function strokeForSpan(
  span: TraceSpan,
  selected: boolean,
  failing: boolean,
) {
  if (selected) return COLORS.purple;
  if (failing) return COLORS.red;
  return statusColor(span);
}

interface TraceCanvasProps {
  spans: TraceSpan[];
  selectedId: string | null;
  failingSpanId: string | null;
  warningsBySpan: Map<string, number>;
  onSelect: (spanId: string) => void;
}

export function TraceCanvas({
  spans,
  selectedId,
  failingSpanId,
  warningsBySpan,
  onSelect,
}: TraceCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useLayoutEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setWidth(containerRef.current.clientWidth);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const spanById = useMemo(
    () => new Map(spans.map((span) => [span.id, span])),
    [spans],
  );

  const layout = useMemo(() => {
    const steps = spans
      .filter((span) => VISIBLE_KINDS.has(span.kind))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

    let maxContentDepth = 0;
    for (const step of steps) {
      const depth = contentTrackDepth(step, spanById);
      if (depth > maxContentDepth) maxContentDepth = depth;
    }
    const subagentLaneCount = maxSubagentLanes(steps);

    const positions = steps.map((span, index) => {
      const row = rowIndex(span, spanById, subagentLaneCount, maxContentDepth);
      const y = rowY(row);
      return {
        span,
        row,
        x: LABEL_GUTTER + LEFT_PADDING + index * (SLOT_WIDTH + SLOT_GAP),
        y,
        centerY: y + NODE_HEIGHT / 2,
      };
    });

    const maxRow =
      positions.length === 0
        ? 1
        : Math.max(...positions.map((position) => position.row));
    const height = rowY(maxRow) + NODE_HEIGHT + 32;

    const rowLabels: string[] = [];
    for (let row = 0; row <= maxRow; row += 1) {
      rowLabels.push(
        trackLabel(row, steps, spanById, subagentLaneCount, maxContentDepth),
      );
    }

    const positionBySpanId = new Map(
      positions.map((position) => [position.span.id, position]),
    );

    const edges: {
      kind: EdgeKind;
      from: (typeof positions)[number];
      to: (typeof positions)[number];
    }[] = [];
    const linked = new Set<string>();

    const pushEdge = (
      kind: EdgeKind,
      from: (typeof positions)[number],
      to: (typeof positions)[number],
    ) => {
      const key = kind + ":" + from.span.id + "->" + to.span.id;
      if (linked.has(key)) return;
      linked.add(key);
      edges.push({ kind, from, to });
    };

    for (let index = 0; index < positions.length; index += 1) {
      const current = positions[index]!;
      if (isSubagentTask(current.span) || current.span.attributes.spawnsSubagents === true) {
        for (const delegate of positions) {
          if (delegate.span.parentId !== current.span.id) continue;
          if (delegate.row <= current.row) continue;
          pushEdge("delegate", current, delegate);
        }
      }

      if (current.span.name === "subagent.result" && current.span.parentId) {
        const parent = positionBySpanId.get(current.span.parentId);
        if (parent && parent.row < current.row) {
          pushEdge("return", current, parent);
        }
      }

      if (
        isSubagentTask(current.span) &&
        current.span.status !== "running" &&
        current.span.parentId
      ) {
        const parent = positionBySpanId.get(current.span.parentId);
        if (parent && parent.row < current.row) {
          pushEdge("return", current, parent);
        }
      }

      for (let nextIndex = index + 1; nextIndex < positions.length; nextIndex += 1) {
        const next = positions[nextIndex]!;
        if (next.row !== current.row) continue;
        pushEdge("sequential", current, next);
        break;
      }

      if (current.row === 0 && current.span.actor === "user") {
        for (let nextIndex = index + 1; nextIndex < positions.length; nextIndex += 1) {
          const next = positions[nextIndex]!;
          if (next.row !== 1) continue;
          if (contentTrackDepth(next.span, spanById) !== 0) continue;
          pushEdge("sequential", current, next);
          break;
        }
      }
    }

    return { steps, positions, maxRow, height, rowLabels, edges };
  }, [spanById, spans]);

  return (
    <div className="trace-canvas" ref={containerRef}>
      <Stage
        width={width}
        height={layout.height}
        draggable
        onMouseEnter={(event) => {
          event.target.getStage()!.container().style.cursor = "grab";
        }}
      >
        <Layer>
          <Text
            text="◷ time →"
            x={12}
            y={10}
            fontSize={12}
            fill={COLORS.muted}
          />
          {layout.rowLabels.map((label, row) => (
            <Group key={"lane-" + row}>
              <Line
                points={[
                  LABEL_GUTTER,
                  TOP_PADDING + row * ROW_GAP + NODE_HEIGHT + 10,
                  Math.max(width, layout.positions.at(-1)?.x ?? 0) +
                    SLOT_WIDTH +
                    40,
                  TOP_PADDING + row * ROW_GAP + NODE_HEIGHT + 10,
                ]}
                stroke={COLORS.line}
                strokeWidth={1}
                dash={[4, 6]}
              />
              <Text
                text={label}
                x={8}
                y={TOP_PADDING + row * ROW_GAP + 22}
                width={LABEL_GUTTER - 12}
                align="right"
                fontSize={11}
                fill={COLORS.muted}
                wrap="none"
                ellipsis
              />
            </Group>
          ))}
          {layout.edges.map(({ kind, from, to }) => {
            const gap =
              new Date(to.span.startedAt).getTime() -
              new Date(from.span.endedAt ?? from.span.startedAt).getTime();
            const label = edgeLabel(kind, from.span, from.row, to.row, gap);
            const fromPoint = connectionPoint(from, "from", kind);
            const toPoint = connectionPoint(to, "to", kind);
            const bendOffset = edgeBendOffset(kind, from, to);
            const points = edgePoints(
              fromPoint.x,
              fromPoint.y,
              toPoint.x,
              toPoint.y,
              bendOffset,
            );
            const stroke = edgeStroke(
              selectedId,
              from.span.id,
              to.span.id,
              kind,
            );
            const selectedEdge =
              kind === "return"
                ? selectedId === from.span.id
                : selectedId === from.span.id || selectedId === to.span.id;
            return (
              <Arrow
                key={kind + ":" + from.span.id + "->" + to.span.id}
                points={points}
                stroke={stroke}
                fill={stroke}
                strokeWidth={selectedEdge ? 2.5 : 2}
                pointerLength={12}
                pointerWidth={10}
                lineJoin="round"
              />
            );
          })}
          {layout.positions.map(({ span, x, y, centerY }) => {
            const warnings = warningsBySpan.get(span.id) ?? 0;
            const selected = span.id === selectedId;
            const failing = span.id === failingSpanId;
            const stroke = strokeForSpan(span, selected, failing);
            let durationLabel = "running";
            if (span.status !== "running") {
              durationLabel = formatDuration(
                span.durationMs ?? spanDuration(span.startedAt, span.endedAt),
              );
            }
            if (failing) durationLabel += " · failing step";

            return (
              <Group
                key={span.id}
                onClick={() => onSelect(span.id)}
                onTap={() => onSelect(span.id)}
                onMouseEnter={(event) => {
                  event.target.getStage()!.container().style.cursor = "pointer";
                }}
                onMouseLeave={(event) => {
                  event.target.getStage()!.container().style.cursor = "grab";
                }}
              >
                {span.actor === "user" ? (
                  <>
                    <Circle
                      x={x + SLOT_WIDTH / 2}
                      y={centerY}
                      radius={26}
                      fill={COLORS.paper}
                      stroke={stroke}
                      strokeWidth={selected || failing ? 3 : 2}
                    />
                    <Text
                      text="user"
                      x={x + SLOT_WIDTH / 2 - 26}
                      y={centerY - 6}
                      width={52}
                      align="center"
                      fontSize={11}
                      fill={COLORS.ink}
                    />
                    <Text
                      text={span.label}
                      x={x}
                      y={y + NODE_HEIGHT + 6}
                      width={SLOT_WIDTH}
                      align="center"
                      fontSize={11}
                      fill={COLORS.muted}
                      wrap="none"
                      ellipsis
                    />
                  </>
                ) : (
                  <>
                    <Rect
                      x={x}
                      y={y}
                      width={SLOT_WIDTH}
                      height={NODE_HEIGHT}
                      cornerRadius={16}
                      fill={COLORS.paper}
                      stroke={stroke}
                      strokeWidth={selected || failing ? 3 : 2}
                      shadowColor="rgba(39, 38, 33, 0.18)"
                      shadowBlur={selected ? 12 : 6}
                      shadowOffsetY={3}
                    />
                    <Text
                      text={stepLabel(span)}
                      x={x + 12}
                      y={y + 12}
                      width={SLOT_WIDTH - 24}
                      height={34}
                      fontSize={12}
                      lineHeight={1.25}
                      fill={COLORS.ink}
                      wrap="word"
                      ellipsis
                    />
                    <Text
                      text={durationLabel}
                      x={x + 12}
                      y={y + NODE_HEIGHT - 18}
                      width={SLOT_WIDTH - 24}
                      fontSize={10}
                      fill={failing ? COLORS.red : COLORS.muted}
                    />
                  </>
                )}
                {warnings > 0 && (
                  <>
                    <Circle
                      x={
                        span.actor === "user"
                          ? x + SLOT_WIDTH / 2 + 22
                          : x + SLOT_WIDTH - 6
                      }
                      y={span.actor === "user" ? centerY - 22 : y - 2}
                      radius={11}
                      fill={COLORS.warning}
                    />
                    <Text
                      text={String(warnings)}
                      x={
                        (span.actor === "user"
                          ? x + SLOT_WIDTH / 2 + 22
                          : x + SLOT_WIDTH - 6) - 11
                      }
                      y={(span.actor === "user" ? centerY - 22 : y - 2) - 5}
                      width={22}
                      align="center"
                      fontSize={11}
                      fontStyle="bold"
                      fill="#ffffff"
                    />
                  </>
                )}
              </Group>
            );
          })}
          {layout.edges.map(({ kind, from, to }) => {
            const gap =
              new Date(to.span.startedAt).getTime() -
              new Date(from.span.endedAt ?? from.span.startedAt).getTime();
            const label = edgeLabel(kind, from.span, from.row, to.row, gap);
            const fromPoint = connectionPoint(from, "from", kind);
            const toPoint = connectionPoint(to, "to", kind);
            const bendOffset = edgeBendOffset(kind, from, to);
            const points = edgePoints(
              fromPoint.x,
              fromPoint.y,
              toPoint.x,
              toPoint.y,
              bendOffset,
            );
            const box = edgeLabelLayout(kind, label, from.span, to.span, points);
            return (
              <Group key={"label:" + kind + ":" + from.span.id + "->" + to.span.id}>
                <Rect
                  x={box.x - 6}
                  y={box.y - 4}
                  width={box.width + 12}
                  height={box.height + 8}
                  fill={COLORS.paper}
                  cornerRadius={4}
                  stroke={COLORS.line}
                  strokeWidth={1}
                  shadowColor="rgba(39, 38, 33, 0.12)"
                  shadowBlur={4}
                  shadowOffsetY={1}
                />
                <Text
                  text={label}
                  x={box.x}
                  y={box.y + 2}
                  width={box.width}
                  align="center"
                  verticalAlign="middle"
                  fontSize={12}
                  fontStyle={kind === "return" ? "italic" : "normal"}
                  fill={COLORS.ink}
                />
              </Group>
            );
          })}
        </Layer>
      </Stage>
      {layout.steps.length === 0 && (
        <div className="trace-canvas-empty">Waiting for the first step…</div>
      )}
    </div>
  );
}
