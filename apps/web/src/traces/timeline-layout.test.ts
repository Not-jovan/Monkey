import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../types";
import {
  layoutTimeline,
  timelineTickLabels,
  clampTimelinePan,
  zoomTimeline,
  visibleTimelineTicks,
} from "./timeline-layout";

function span(overrides: Partial<TraceSpan> & Pick<TraceSpan, "id" | "name">) {
  return {
    traceId: "trace-1",
    parentId: null,
    label: overrides.label ?? overrides.name,
    kind: overrides.kind ?? "tool_call",
    actor: overrides.actor ?? "agent",
    status: overrides.status ?? "ok",
    startedAt: overrides.startedAt ?? "2026-08-26T13:46:40.000Z",
    endedAt: overrides.endedAt ?? "2026-08-26T13:46:41.000Z",
    durationMs: overrides.durationMs ?? 1000,
    attributes: overrides.attributes ?? {},
    error: null,
    ...overrides,
  } satisfies TraceSpan;
}

describe("layoutTimeline", () => {
  it("places bars by wall-clock time across actor lanes", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-26T13:46:40.000Z",
      endedAt: "2026-08-26T13:46:40.000Z",
      durationMs: 0,
    });
    const model = span({
      id: "model",
      name: "codex.api_request",
      kind: "model_call",
      startedAt: "2026-08-26T13:46:40.000Z",
      endedAt: "2026-08-26T13:46:42.000Z",
      durationMs: 2000,
    });
    const tool = span({
      id: "tool",
      name: "tool.exec_command",
      startedAt: "2026-08-26T13:46:42.000Z",
      endedAt: "2026-08-26T13:46:44.000Z",
      durationMs: 2000,
    });

    const layout = layoutTimeline([prompt, model, tool], Date.parse("2026-08-26T13:46:44.000Z"));
    const byId = Object.fromEntries(
      layout.bars.map((bar) => [bar.span.id, bar]),
    );

    expect(layout.durationMs).toBe(4000);
    expect(byId.prompt?.left).toBe(0);
    expect(byId.model?.left).toBe(0);
    expect(byId.model?.width).toBeCloseTo(0.5);
    expect(byId.tool?.left).toBeCloseTo(0.5);
    expect(byId.tool?.width).toBeCloseTo(0.5);
    expect(byId.prompt?.row).toBe(0);
    expect(byId.model?.row).toBe(1);
    expect(byId.prompt?.stack).toBe(0);
    expect(byId.model?.stack).toBe(0);
    expect(byId.tool?.stack).toBe(0);
    expect(layout.stacksByLane.get("root")).toBe(1);
    expect(timelineTickLabels(layout)).toEqual(["0", "2.0 s", "4.0 s"]);
  });

  it("keeps sequential short steps on one stack", () => {
    const tool = span({
      id: "tool",
      name: "tool.exec_command",
      startedAt: "2026-08-26T13:46:40.000Z",
      endedAt: "2026-08-26T13:46:40.083Z",
      durationMs: 83,
    });
    const model = span({
      id: "model",
      name: "codex.api_request",
      kind: "model_call",
      startedAt: "2026-08-26T13:46:40.098Z",
      endedAt: "2026-08-26T13:46:41.300Z",
      durationMs: 1202,
    });
    const later = span({
      id: "later",
      name: "tool.exec_command",
      startedAt: "2026-08-26T13:47:56.000Z",
      endedAt: "2026-08-26T13:47:58.000Z",
      durationMs: 2000,
    });
    const layout = layoutTimeline(
      [tool, model, later],
      Date.parse("2026-08-26T13:47:58.000Z"),
    );
    const byId = Object.fromEntries(
      layout.bars.map((bar) => [bar.span.id, bar]),
    );
    expect(layout.stacksByLane.get("root")).toBe(1);
    expect(byId.tool?.stack).toBe(0);
    expect(byId.model?.stack).toBe(0);
    expect(byId.later?.stack).toBe(0);
    expect(byId.tool?.width).toBeLessThan(0.01);
  });

  it("stacks overlapping bars on the same lane", () => {
    const first = span({
      id: "tool-a",
      name: "tool.exec_command",
      startedAt: "2026-08-26T13:46:40.000Z",
      endedAt: "2026-08-26T13:46:42.000Z",
    });
    const second = span({
      id: "tool-b",
      name: "tool.exec_command",
      startedAt: "2026-08-26T13:46:40.050Z",
      endedAt: "2026-08-26T13:46:42.000Z",
    });
    const layout = layoutTimeline(
      [first, second],
      Date.parse("2026-08-26T13:46:42.000Z"),
    );
    const byId = Object.fromEntries(
      layout.bars.map((bar) => [bar.span.id, bar]),
    );
    expect(byId["tool-a"]?.stack).toBe(0);
    expect(byId["tool-b"]?.stack).toBe(1);
    expect(layout.stacksByLane.get("root")).toBe(2);
  });

  it("keeps a running step open until now", () => {
    const running = span({
      id: "model",
      name: "codex.api_request",
      kind: "model_call",
      status: "running",
      startedAt: "2026-08-26T13:46:40.000Z",
      endedAt: null,
      durationMs: null,
    });
    const now = Date.parse("2026-08-26T13:46:50.000Z");
    const layout = layoutTimeline([running], now);
    expect(layout.durationMs).toBe(10_000);
    expect(layout.bars[0]?.width).toBeCloseTo(1);
  });

  it("does not stretch a cut-off run to when the process died", () => {
    const root = span({
      id: "root",
      name: "agent.run",
      kind: "run",
      status: "error",
      startedAt: "2026-08-31T02:01:16.088Z",
      endedAt: "2026-08-31T02:15:06.619Z",
      durationMs: null,
      error: "Server restarted during this run",
    });
    const step = span({
      id: "step",
      name: "audit.step.summary",
      kind: "model_call",
      startedAt: "2026-08-31T02:01:16.088Z",
      endedAt: "2026-08-31T02:01:28.242Z",
      durationMs: 12_154,
    });
    const layout = layoutTimeline(
      [root, step],
      Date.parse("2026-08-31T02:15:06.619Z"),
    );
    expect(layout.durationMs).toBe(12_154);
  });
});

describe("timeline zoom and pan", () => {
  it("clamps pan so the view stays over the content", () => {
    expect(clampTimelinePan(0, 200, 200)).toBe(0);
    expect(clampTimelinePan(-50, 200, 200)).toBe(0);
    expect(clampTimelinePan(20, 200, 800)).toBe(0);
    expect(clampTimelinePan(-700, 200, 800)).toBe(-600);
  });

  it("keeps the pointed time fixed when zooming", () => {
    const before = zoomTimeline({
      zoom: 1,
      panX: 0,
      viewWidth: 200,
      pointerX: 50,
      factor: 2,
    });
    expect(before.zoom).toBe(2);
    expect(before.panX).toBe(-50);
    const after = zoomTimeline({
      zoom: before.zoom,
      panX: before.panX,
      viewWidth: 200,
      pointerX: 50,
      factor: 0.5,
    });
    expect(after.zoom).toBe(1);
    expect(after.panX).toBe(0);
  });

  it("labels the visible window, not the whole run", () => {
    const layout = layoutTimeline(
      [
        span({
          id: "tool",
          name: "tool.exec_command",
          startedAt: "2026-08-26T13:46:40.000Z",
          endedAt: "2026-08-26T13:46:50.000Z",
        }),
      ],
      Date.parse("2026-08-26T13:46:50.000Z"),
    );
    expect(visibleTimelineTicks(layout, -200, 200, 400)).toEqual([
      "5.0 s",
      "7.5 s",
      "10.0 s",
    ]);
  });
});
