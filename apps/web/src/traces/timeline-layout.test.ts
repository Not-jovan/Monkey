import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../types";
import { layoutTimeline, timelineTickLabels } from "./timeline-layout";

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
    expect(timelineTickLabels(layout)).toEqual(["0", "2.0 s", "4.0 s"]);
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
});
