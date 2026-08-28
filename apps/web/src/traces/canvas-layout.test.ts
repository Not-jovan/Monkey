import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../types";
import { laneIdForSpan, layoutSwimlanes, orderedLaneIds } from "./canvas-layout";

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

describe("canvas swimlanes", () => {
  it("puts sibling subagents on separate tracks under the parent", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-26T13:46:39.000Z",
    });
    const spawnA = span({
      id: "spawn-a",
      name: "tool.spawn_agent",
      startedAt: "2026-08-26T13:46:40.000Z",
      attributes: { subagent: true, laneId: "root", subagentType: "worker" },
    });
    const spawnB = span({
      id: "spawn-b",
      name: "tool.spawn_agent",
      startedAt: "2026-08-26T13:46:40.100Z",
      attributes: { subagent: true, laneId: "root", subagentType: "reviewer" },
    });
    const modelA = span({
      id: "model-a",
      name: "codex.api_request",
      kind: "model_call",
      parentId: "spawn-a",
      startedAt: "2026-08-26T13:46:41.000Z",
      attributes: { laneId: "spawn-a" },
    });
    const modelB = span({
      id: "model-b",
      name: "codex.api_request",
      kind: "model_call",
      parentId: "spawn-b",
      startedAt: "2026-08-26T13:46:41.050Z",
      attributes: { laneId: "spawn-b" },
    });

    const spans = [prompt, spawnA, spawnB, modelA, modelB];
    const spanById = new Map(spans.map((item) => [item.id, item]));
    const lanes = orderedLaneIds(spans, spanById);

    expect(lanes.map((lane) => lane.id)).toEqual([
      "user",
      "root",
      "spawn-a",
      "spawn-b",
    ]);
    expect(laneIdForSpan(modelA, spanById)).toBe("spawn-a");
    expect(laneIdForSpan(modelB, spanById)).toBe("spawn-b");
    expect(laneIdForSpan(spawnA, spanById)).toBe("root");

    const layout = layoutSwimlanes(spans, 1200);
    const rowOf = (id: string) =>
      layout.positions.find((position) => position.span.id === id)?.row;
    expect(rowOf("prompt")).toBe(0);
    expect(rowOf("spawn-a")).toBe(1);
    expect(rowOf("spawn-b")).toBe(1);
    expect(rowOf("model-a")).toBe(2);
    expect(rowOf("model-b")).toBe(3);

    const delegateTargets = layout.edges
      .filter((edge) => edge.kind === "delegate")
      .map((edge) => edge.to.span.id)
      .sort();
    expect(delegateTargets).toEqual(["model-a", "model-b"]);
  });

  it("nests an inner spawn on its own track under the outer subagent", () => {
    const outer = span({
      id: "outer",
      name: "tool.Task",
      attributes: { subagent: true, laneId: "root", subagentType: "generalPurpose" },
    });
    const inner = span({
      id: "inner",
      name: "tool.Task",
      parentId: "outer",
      startedAt: "2026-08-26T13:46:42.000Z",
      attributes: { subagent: true, laneId: "outer", subagentType: "explore" },
    });
    const exec = span({
      id: "exec",
      name: "tool.exec_command",
      parentId: "inner",
      startedAt: "2026-08-26T13:46:43.000Z",
      attributes: { laneId: "inner", toolName: "exec_command" },
    });

    const spans = [outer, inner, exec];
    const layout = layoutSwimlanes(spans, 1200);
    const rowOf = (id: string) =>
      layout.positions.find((position) => position.span.id === id)?.row;
    expect(rowOf("outer")).toBe(0);
    expect(rowOf("inner")).toBe(1);
    expect(rowOf("exec")).toBe(2);
    expect(layout.lanes.map((lane) => lane.label)).toEqual([
      "agent",
      "sub · generalPurpose",
      "sub · explore",
    ]);
  });

  it("keeps each actor on one row as time runs left to right", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-26T13:46:00.000Z",
    });
    const models = Array.from({ length: 12 }, (_, index) =>
      span({
        id: "model-" + index,
        name: "codex.api_request",
        kind: "model_call",
        startedAt: "2026-08-26T13:46:" + String(10 + index).padStart(2, "0") + ".000Z",
        attributes: { laneId: "root" },
      }),
    );
    const layout = layoutSwimlanes([prompt, ...models], 400);
    const agentYs = new Set(
      layout.positions
        .filter((position) => position.laneId === "root")
        .map((position) => position.y),
    );
    expect(agentYs.size).toBe(1);
    const xs = layout.positions
      .filter((position) => position.laneId === "root")
      .map((position) => position.x);
    for (let index = 0; index + 1 < xs.length; index += 1) {
      expect(xs[index]!).toBeLessThan(xs[index + 1]!);
    }
    expect(layout.contentWidth).toBeGreaterThan(400);
  });

  it("keeps prompt and terminate on the same user lane", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-26T13:46:00.000Z",
    });
    const stop = span({
      id: "stop",
      name: "user.intervention",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-26T13:47:00.000Z",
    });
    const model = span({
      id: "model",
      name: "codex.api_request",
      kind: "model_call",
      startedAt: "2026-08-26T13:46:10.000Z",
      attributes: { laneId: "root" },
    });
    const layout = layoutSwimlanes([prompt, model, stop]);
    const userRows = layout.positions
      .filter((position) => position.span.actor === "user")
      .map((position) => position.row);
    expect(userRows).toEqual([0, 0]);
    expect(layout.lanes.filter((lane) => lane.label === "user")).toHaveLength(1);
  });

  it("keeps exec_command on the agent row even when the command is codex exec", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-28T03:19:15.665Z",
    });
    const model = span({
      id: "model",
      name: "codex.api_request",
      kind: "model_call",
      startedAt: "2026-08-28T03:19:16.160Z",
      attributes: { laneId: "root" },
    });
    const execA = span({
      id: "exec-a",
      name: "tool.exec_command",
      startedAt: "2026-08-28T03:19:24.322Z",
      attributes: {
        laneId: "root",
        toolName: "exec_command",
        subagent: true,
        arguments:
          '{"cmd": "codex exec \'Hello 1\' --sandbox danger-full-access"}',
      },
    });
    const execB = span({
      id: "exec-b",
      name: "tool.exec_command",
      startedAt: "2026-08-28T03:19:24.329Z",
      attributes: {
        laneId: "root",
        toolName: "exec_command",
        subagent: true,
        arguments:
          '{"cmd": "codex exec \'Hello 2\' --sandbox danger-full-access"}',
      },
    });
    const leftover = span({
      id: "result-a",
      name: "subagent.result",
      kind: "system",
      parentId: "exec-a",
      startedAt: "2026-08-28T03:19:24.322Z",
      attributes: {
        synthesized: true,
        result: "Hello 1",
        laneId: "exec-a",
      },
    });

    const layout = layoutSwimlanes(
      [prompt, model, execA, execB, leftover],
      1200,
    );
    const rowOf = (id: string) =>
      layout.positions.find((position) => position.span.id === id)?.row;
    expect(rowOf("prompt")).toBe(0);
    expect(rowOf("model")).toBe(1);
    expect(rowOf("exec-a")).toBe(1);
    expect(rowOf("exec-b")).toBe(1);
    expect(rowOf("result-a")).toBeUndefined();
    expect(layout.lanes.map((lane) => lane.label)).toEqual(["user", "agent"]);
    expect(layout.edges.filter((edge) => edge.kind === "delegate")).toEqual([]);
  });
});
