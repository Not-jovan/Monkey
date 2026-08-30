import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Arrow, Circle, Group, Layer, Line, Rect, Stage, Text } from "react-konva";
import type { TraceSpan } from "../types";
import {
  LABEL_GUTTER,
  NODE_HEIGHT,
  SLOT_WIDTH,
  layoutSwimlanes,
  parseSubagentIndex,
  type EdgeKind,
} from "./canvas-layout";
import {
  isErrorStep,
  isSubagentTask,
  previewLabel,
  subagentCallLabel,
  subagentResultHeadline,
} from "./steps";
import { formatDuration, spanDuration } from "./format";

// Gaps shorter than this are not worth a label; the arrow matters more.
const GAP_LABEL_MIN_MS = 1_000;
// Lifts a gap label clear of the connector it describes.
const GAP_LABEL_LIFT = 10;
const EDGE_LABEL_GAP = 18;

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
  // Hex stand-in for oklch(93.6% 0.032 17.717); Konva/canvas 2d misses oklch.
  errorFill: "#fce9e7",
};

function statusColor(span: TraceSpan) {
  if (span.status === "error") return COLORS.red;
  if (span.status === "running") return COLORS.amber;
  return COLORS.green;
}

function stepLabel(span: TraceSpan) {
  if (span.kind === "run" && isErrorStep(span)) return "Run failed";
  if (span.kind === "turn" && isErrorStep(span)) return "Turn failed";
  if (span.kind === "model_call") return span.label;

  if (span.name === "subagent.result") {
    return subagentResultHeadline(span) ?? "returned";
  }

  if (span.kind === "tool_call") {
    const toolName =
      typeof span.attributes.toolName === "string"
        ? span.attributes.toolName
        : span.name.replace(/^tool\./, "");
    if (isSubagentTask(span)) {
      const call = subagentCallLabel(span);
      if (call) {
        // Auditor spawns already name the check and the step. Prefixing
        // Subagent ate the line the step needs.
        if (typeof span.attributes.targetLabel === "string") return call;
        return "Subagent · " + call;
      }
      if (span.label.startsWith("Subagent")) return span.label;
      return "Subagent · task";
    }
    if (span.label.startsWith("Called ")) {
      return "Tool · " + span.label.slice("Called ".length);
    }
    return "Tool · " + toolName;
  }

  return span.label;
}

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
  if (kind === "delegate" && toRow > fromRow && isSubagentTask(from)) {
    const call = subagentCallLabel(from);
    if (call) return previewLabel(call, 28);
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

function isStacked(
  from: { column: number; row: number; x: number; y: number },
  to: { column: number; row: number; x: number; y: number },
) {
  return from.column === to.column && from.row !== to.row;
}

function stackedPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  downward: boolean,
) {
  const x = from.x + SLOT_WIDTH / 2;
  if (downward) {
    return [x, from.y + NODE_HEIGHT, x, to.y];
  }
  return [x, from.y, x, to.y + NODE_HEIGHT];
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
  const panLayerRef = useRef<Konva.Layer | null>(null);
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

  const layout = useMemo(
    () => layoutSwimlanes(spans, width),
    [spans, width],
  );

  const clampPanX = (x: number) => {
    const minX = Math.min(0, width - layout.contentWidth);
    return Math.max(minX, Math.min(0, x));
  };

  useLayoutEffect(() => {
    const layer = panLayerRef.current;
    if (!layer) return;
    layer.x(clampPanX(layer.x()));
  }, [layout.contentWidth, width]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const layer = panLayerRef.current;
      if (!layer) return;
      const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      layer.x(clampPanX(layer.x() - delta));
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [layout.contentWidth, width]);

  return (
    <div className="trace-canvas" ref={containerRef}>
      <Stage width={width} height={layout.height}>
        <Layer listening={false}>
          {layout.lanes.map((lane) => (
            <Line
              key={"rail-" + lane.row}
              points={[
                LABEL_GUTTER,
                lane.y + NODE_HEIGHT + 8,
                width,
                lane.y + NODE_HEIGHT + 8,
              ]}
              stroke={COLORS.line}
              strokeWidth={1}
              dash={[4, 6]}
              perfectDrawEnabled={false}
            />
          ))}
        </Layer>
        <Layer
          ref={panLayerRef}
          draggable
          dragBoundFunc={(pos) => ({ x: clampPanX(pos.x), y: 0 })}
        >
          <Rect
            x={0}
            y={0}
            width={Math.max(width, layout.contentWidth)}
            height={layout.height}
            fill="rgba(0,0,0,0.01)"
            perfectDrawEnabled={false}
          />
          {layout.edges.map(({ kind, from, to }) => {
            const stacked = isStacked(from, to);
            const points = stacked
              ? stackedPoints(from, to, to.row > from.row)
              : edgePoints(
                  connectionPoint(from, "from", kind).x,
                  connectionPoint(from, "from", kind).y,
                  connectionPoint(to, "to", kind).x,
                  connectionPoint(to, "to", kind).y,
                  edgeBendOffset(kind, from, to),
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
                listening={false}
                perfectDrawEnabled={false}
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
            const errored = isErrorStep(span);
            const stroke = strokeForSpan(span, selected, failing || errored);
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
                onClick={() =>
                  onSelect(
                    span.attributes.layoutOnly === true && span.parentId
                      ? span.parentId
                      : span.id,
                  )
                }
                onTap={() =>
                  onSelect(
                    span.attributes.layoutOnly === true && span.parentId
                      ? span.parentId
                      : span.id,
                  )
                }
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
                      fill={errored ? COLORS.errorFill : COLORS.paper}
                      stroke={stroke}
                      strokeWidth={selected || failing || errored ? 3 : 2}
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
                      fill={errored ? COLORS.errorFill : COLORS.paper}
                      stroke={stroke}
                      strokeWidth={selected || failing || errored ? 3 : 2}
                      perfectDrawEnabled={false}
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
                      fill={failing || errored ? COLORS.red : COLORS.muted}
                    />
                  </>
                )}
                {errored && (
                  <>
                    <Circle
                      x={
                        span.actor === "user"
                          ? x + SLOT_WIDTH / 2 + 22
                          : x + SLOT_WIDTH - 6
                      }
                      y={span.actor === "user" ? centerY - 22 : y - 2}
                      radius={11}
                      fill={COLORS.red}
                    />
                    <Text
                      text="!"
                      x={
                        (span.actor === "user"
                          ? x + SLOT_WIDTH / 2 + 22
                          : x + SLOT_WIDTH - 6) - 11
                      }
                      y={(span.actor === "user" ? centerY - 22 : y - 2) - 6}
                      width={22}
                      align="center"
                      fontSize={13}
                      fontStyle="bold"
                      fill="#ffffff"
                    />
                  </>
                )}
                {warnings > 0 && (
                  <>
                    <Circle
                      x={
                        (span.actor === "user"
                          ? x + SLOT_WIDTH / 2 + 22
                          : x + SLOT_WIDTH - 6) - (errored ? 24 : 0)
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
                          : x + SLOT_WIDTH - 6) -
                        (errored ? 24 : 0) -
                        11
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
            const stacked = isStacked(from, to);
            if (stacked) return null;
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
            // A gap label is just a duration; a semantic one names what the
            // edge means. Only the latter earns an opaque chip, because a chip
            // centred on the connector hides the very arrow it annotates.
            const isGap = label === formatDuration(Math.max(gap, 0));
            // Sub-second gaps are noise between back-to-back steps: labelling
            // every "11 ms" buried the arrows without telling anyone anything.
            if (isGap && gap < GAP_LABEL_MIN_MS) return null;
            if (isGap) {
              return (
                <Text
                  key={"label:" + kind + ":" + from.span.id + "->" + to.span.id}
                  listening={false}
                  text={label}
                  x={box.x}
                  y={box.y - GAP_LABEL_LIFT}
                  width={box.width}
                  align="center"
                  fontSize={11}
                  fill={COLORS.muted}
                />
              );
            }
            return (
              <Group
                key={"label:" + kind + ":" + from.span.id + "->" + to.span.id}
                listening={false}
              >
                <Rect
                  x={box.x - 6}
                  y={box.y - 4}
                  width={box.width + 12}
                  height={box.height + 8}
                  fill={COLORS.paper}
                  cornerRadius={4}
                  stroke={COLORS.line}
                  strokeWidth={1}
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
      <div
        className="trace-canvas-gutter"
        style={{ height: layout.height }}
      >
        <div className="trace-canvas-gutter-time">◷ time →</div>
        {layout.lanes.map((lane) => (
          <div
            key={"label-" + lane.row}
            className="trace-canvas-gutter-label"
            style={{ top: lane.y + 18 }}
            title={lane.label}
          >
            {lane.label}
          </div>
        ))}
      </div>
      {layout.steps.length === 0 && (
        <div className="trace-canvas-empty">Waiting for the first step…</div>
      )}
    </div>
  );
}
