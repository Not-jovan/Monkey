import { useLayoutEffect, useRef, useState } from "react";
import { Arrow, Circle, Group, Layer, Rect, Stage, Text } from "react-konva";
import type { TraceSpan } from "../types";
import { formatDuration, spanDuration } from "./format";

const SLOT_WIDTH = 190;
const SLOT_GAP = 80;
const NODE_HEIGHT = 62;
const USER_ROW_Y = 46;
const AGENT_ROW_Y = 150;
const STAGE_HEIGHT = 260;

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

interface TraceCanvasProps {
  spans: TraceSpan[];
  selectedId: string | null;
  failingSpanId: string | null;
  warningsBySpan: Map<string, number>;
  onSelect: (spanId: string) => void;
}

// The plan's flow view: time moves left to right, the user actor sits on its
// own row, and each step is a node the reviewer can click for details.
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

  const steps = spans
    .filter((span) =>
      ["user_action", "tool_call", "model_call", "system"].includes(span.kind),
    )
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  const positions = steps.map((span, index) => {
    const x = 40 + index * (SLOT_WIDTH + SLOT_GAP);
    const y = span.actor === "user" ? USER_ROW_Y : AGENT_ROW_Y;
    return { span, x, y, centerY: y + NODE_HEIGHT / 2 };
  });

  return (
    <div className="trace-canvas" ref={containerRef}>
      <Stage
        width={width}
        height={STAGE_HEIGHT}
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
          {positions.map((position, index) => {
            const next = positions[index + 1];
            if (!next) return null;
            const gap =
              new Date(next.span.startedAt).getTime() -
              new Date(position.span.endedAt ?? position.span.startedAt).getTime();
            const label =
              position.span.actor === "user"
                ? "User " +
                  (position.span.name === "user.intervention"
                    ? '"Terminated"'
                    : '"Prompt"')
                : formatDuration(Math.max(gap, 0));
            const fromX = position.x + SLOT_WIDTH - 8;
            const toX = next.x + 6;
            const midX = (fromX + toX) / 2;
            return (
              <Group key={"edge-" + position.span.id}>
                <Arrow
                  points={[fromX, position.centerY, toX, next.centerY]}
                  stroke={COLORS.line}
                  fill={COLORS.line}
                  strokeWidth={2}
                  pointerLength={8}
                  pointerWidth={7}
                />
                <Text
                  text={label}
                  x={midX - 48}
                  y={(position.centerY + next.centerY) / 2 - 22}
                  width={96}
                  align="center"
                  fontSize={11}
                  fill={COLORS.muted}
                />
              </Group>
            );
          })}
          {positions.map(({ span, x, y, centerY }) => {
            const warnings = warningsBySpan.get(span.id) ?? 0;
            const selected = span.id === selectedId;
            const failing = span.id === failingSpanId;
            const stroke = selected
              ? COLORS.purple
              : failing
                ? COLORS.red
                : statusColor(span);
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
                      text={span.label}
                      x={x + 12}
                      y={y + 10}
                      width={SLOT_WIDTH - 24}
                      height={30}
                      fontSize={12}
                      lineHeight={1.25}
                      fill={COLORS.ink}
                      wrap="word"
                      ellipsis
                    />
                    <Text
                      text={
                        (span.status === "running"
                          ? "running"
                          : formatDuration(
                              span.durationMs ??
                                spanDuration(span.startedAt, span.endedAt),
                            )) + (failing ? " · failing step" : "")
                      }
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
                      x={span.actor === "user" ? x + SLOT_WIDTH / 2 + 22 : x + SLOT_WIDTH - 6}
                      y={span.actor === "user" ? centerY - 22 : y - 2}
                      radius={11}
                      fill={COLORS.warning}
                    />
                    <Text
                      text={String(warnings)}
                      x={(span.actor === "user" ? x + SLOT_WIDTH / 2 + 22 : x + SLOT_WIDTH - 6) - 11}
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
        </Layer>
      </Stage>
      {steps.length === 0 && (
        <div className="trace-canvas-empty">Waiting for the first step…</div>
      )}
    </div>
  );
}
