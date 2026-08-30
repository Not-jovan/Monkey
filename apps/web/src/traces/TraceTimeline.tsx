import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Konva from "konva";
import { Group, Layer, Rect, Stage, Text } from "react-konva";
import type { TraceSpan } from "../types";
import { formatDuration, spanDuration } from "./format";
import { isErrorStep, stepHeadline } from "./steps";
import {
  clampTimelinePan,
  layoutTimeline,
  timelineContentWidth,
  visibleTimelineTicks,
  zoomTimeline,
  type TimelineBar,
  type TimelineLayout,
} from "./timeline-layout";

interface TraceTimelineProps {
  spans: TraceSpan[];
  selectedId: string | null;
  failingSpanId: string | null;
  warningsBySpan: Map<string, number>;
  onSelect: (spanId: string) => void;
}

const COLORS = {
  ink: "#20211f",
  paper: "#fbfaf7",
  line: "#deddd6",
  purple: "#6954d9",
  red: "#c55353",
  errorFill: "#fce9e7",
  runningFill: "#faf3dd",
  runningLine: "#e4cf8f",
  track: "#f4f3ef",
};

const BAR_HEIGHT = 22;
const STACK_PITCH = 28;
const TRACK_PAD = 6;
const TRACK_GAP = 8;
const MIN_TICK_PX = 2;
const LABEL_MIN_PX = 52;

function trackHeight(stacks: number) {
  return (
    TRACK_PAD * 2 +
    Math.max(1, stacks) * STACK_PITCH -
    (STACK_PITCH - BAR_HEIGHT)
  );
}

function barFill(span: TraceSpan, failing: boolean) {
  if (failing || isErrorStep(span)) return COLORS.errorFill;
  if (span.status === "running") return COLORS.runningFill;
  return COLORS.paper;
}

function barStroke(span: TraceSpan, selected: boolean, failing: boolean) {
  if (selected) return COLORS.purple;
  if (failing || isErrorStep(span)) return COLORS.red;
  if (span.status === "running") return COLORS.runningLine;
  return COLORS.line;
}

function drawnWidth(bar: TimelineBar, contentWidth: number, nextLeft: number) {
  const x = bar.left * contentWidth;
  const natural = bar.width * contentWidth;
  const room = Math.max(1, nextLeft - x);
  return Math.min(Math.max(natural, MIN_TICK_PX), room);
}

export function TraceTimeline({
  spans,
  selectedId,
  failingSpanId,
  warningsBySpan,
  onSelect,
}: TraceTimelineProps) {
  const layout = layoutTimeline(spans, Date.now());
  const tracksRef = useRef<HTMLDivElement>(null);
  const panLayerRef = useRef<Konva.Layer | null>(null);
  const dragged = useRef(false);
  const dragOrigin = useRef(0);
  const panningRef = useRef(false);
  const [viewWidth, setViewWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panning, setPanning] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const contentWidth = timelineContentWidth(viewWidth, zoom);
  const viewRef = useRef({ viewWidth: 0, contentWidth: 0, zoom: 1, panX: 0 });
  viewRef.current = { viewWidth, contentWidth, zoom, panX };

  const lanes = useMemo(() => {
    let y = 0;
    return layout.lanes.map((lane) => {
      const stacks = layout.stacksByLane.get(lane.id) ?? 1;
      const height = trackHeight(stacks);
      const top = y;
      y += height + TRACK_GAP;
      return { ...lane, stacks, height, top };
    });
  }, [layout]);

  const stageHeight =
    lanes.length === 0
      ? 0
      : (lanes[lanes.length - 1]?.top ?? 0) +
        (lanes[lanes.length - 1]?.height ?? 0);

  useLayoutEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const next = clampTimelinePan(panX, viewWidth, contentWidth);
    if (next !== panX) setPanX(next);
    if (panningRef.current) return;
    panLayerRef.current?.x(next);
  }, [viewWidth, contentWidth, panX]);

  useEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = viewRef.current;
      if (view.viewWidth <= 0) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        const next = clampTimelinePan(
          view.panX - event.deltaX,
          view.viewWidth,
          view.contentWidth,
        );
        setPanX(next);
        panLayerRef.current?.x(next);
        return;
      }
      const pointerX = event.clientX - el.getBoundingClientRect().left;
      const next = zoomTimeline({
        zoom: view.zoom,
        panX: view.panX,
        viewWidth: view.viewWidth,
        pointerX,
        factor: Math.exp(-event.deltaY * 0.0018),
      });
      setZoom(next.zoom);
      setPanX(next.panX);
      panLayerRef.current?.x(next.panX);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  const drawn = useMemo(
    () => placeBars(layout, lanes, contentWidth),
    [layout, lanes, contentWidth],
  );

  const ticks = visibleTimelineTicks(layout, panX, viewWidth, contentWidth);
  const hovered = drawn.find((entry) => entry.bar.span.id === hoveredId);

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
      <div className="trace-timeline-body">
        <div className="trace-timeline-gutter">
          {lanes.map((lane) => (
            <div
              key={lane.id}
              className="trace-timeline-lane"
              style={{ height: lane.height }}
            >
              {lane.label}
            </div>
          ))}
        </div>
        <div
          className={
            "trace-timeline-tracks" + (panning ? " is-panning" : "")
          }
          ref={tracksRef}
        >
          {viewWidth > 0 && (
            <Stage width={viewWidth} height={stageHeight}>
              <Layer listening={false}>
                {lanes.map((lane) => (
                  <Rect
                    key={lane.id}
                    x={0}
                    y={lane.top}
                    width={viewWidth}
                    height={lane.height}
                    fill={COLORS.track}
                    cornerRadius={8}
                  />
                ))}
              </Layer>
              <Layer
                ref={panLayerRef}
                x={panX}
                draggable
                dragBoundFunc={(pos) => ({
                  x: clampTimelinePan(
                    pos.x,
                    viewRef.current.viewWidth,
                    viewRef.current.contentWidth,
                  ),
                  y: 0,
                })}
                onDragStart={(event) => {
                  dragOrigin.current = event.target.x();
                  dragged.current = false;
                  panningRef.current = true;
                  setPanning(true);
                  setHoveredId(null);
                }}
                onDragMove={(event) => {
                  const x = event.target.x();
                  if (Math.abs(x - dragOrigin.current) > 4) {
                    dragged.current = true;
                  }
                  setPanX(x);
                }}
                onDragEnd={(event) => {
                  const x = clampTimelinePan(
                    event.target.x(),
                    viewRef.current.viewWidth,
                    viewRef.current.contentWidth,
                  );
                  event.target.x(x);
                  setPanX(x);
                  panningRef.current = false;
                  setPanning(false);
                }}
              >
                <Rect
                  x={0}
                  y={0}
                  width={contentWidth}
                  height={stageHeight}
                  fill="rgba(0,0,0,0)"
                />
                {drawn.map(({ bar, x, y, width }) => {
                  const span = bar.span;
                  const selected = span.id === selectedId;
                  const failing = span.id === failingSpanId;
                  const warnings = warningsBySpan.get(span.id) ?? 0;
                  const duration =
                    span.durationMs ??
                    spanDuration(span.startedAt, span.endedAt);
                  const label = stepHeadline(span);
                  const meta =
                    formatDuration(duration) +
                    (warnings > 0 ? " · " + warnings : "");
                  const showLabel = width >= LABEL_MIN_PX;
                  return (
                    <Group
                      key={span.id}
                      x={x}
                      y={y}
                      onClick={() => {
                        if (dragged.current) {
                          dragged.current = false;
                          return;
                        }
                        onSelect(span.id);
                      }}
                      onTap={() => {
                        if (dragged.current) {
                          dragged.current = false;
                          return;
                        }
                        onSelect(span.id);
                      }}
                      onMouseEnter={() => {
                        if (!dragged.current) setHoveredId(span.id);
                      }}
                      onMouseLeave={() => setHoveredId(null)}
                    >
                      <Rect
                        width={width}
                        height={BAR_HEIGHT}
                        fill={barFill(span, failing)}
                        stroke={barStroke(span, selected, failing)}
                        strokeWidth={selected ? 2 : 1}
                        cornerRadius={6}
                        hitStrokeWidth={10}
                      />
                      {showLabel && (
                        <Text
                          x={6}
                          y={5}
                          width={Math.max(0, width - 12)}
                          height={12}
                          text={label + "  " + meta}
                          fontSize={11}
                          fill={COLORS.ink}
                          ellipsis
                          wrap="none"
                          listening={false}
                        />
                      )}
                    </Group>
                  );
                })}
              </Layer>
            </Stage>
          )}
          {hovered && !panning && (
            <div
              className="trace-timeline-tip"
              style={{
                left: Math.min(
                  hovered.x + panX,
                  Math.max(0, viewWidth - 180),
                ),
                top: hovered.y + BAR_HEIGHT + 4,
              }}
            >
              {stepHeadline(hovered.bar.span)}
              {" · "}
              {formatDuration(
                hovered.bar.span.durationMs ??
                  spanDuration(
                    hovered.bar.span.startedAt,
                    hovered.bar.span.endedAt,
                  ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function placeBars(
  layout: TimelineLayout,
  lanes: { id: string; top: number }[],
  contentWidth: number,
) {
  const topOf = new Map(lanes.map((lane) => [lane.id, lane.top]));
  const result: {
    bar: TimelineBar;
    x: number;
    y: number;
    width: number;
  }[] = [];
  const byLane = new Map<string, TimelineBar[]>();
  for (const bar of layout.bars) {
    const list = byLane.get(bar.laneId) ?? [];
    list.push(bar);
    byLane.set(bar.laneId, list);
  }
  for (const [laneId, laneBars] of byLane) {
    const top = topOf.get(laneId) ?? 0;
    const byStack = new Map<number, TimelineBar[]>();
    for (const bar of laneBars) {
      const list = byStack.get(bar.stack) ?? [];
      list.push(bar);
      byStack.set(bar.stack, list);
    }
    for (const list of byStack.values()) {
      list.sort((left, right) => left.left - right.left);
      for (const [index, bar] of list.entries()) {
        const next = list[index + 1];
        const x = bar.left * contentWidth;
        const nextLeft = next ? next.left * contentWidth : contentWidth;
        result.push({
          bar,
          x,
          y: top + TRACK_PAD + bar.stack * STACK_PITCH,
          width: drawnWidth(bar, contentWidth, nextLeft),
        });
      }
    }
  }
  return result;
}
