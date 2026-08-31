import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../types";
import {
  isSubagentTask,
  isVisibleStep,
  orderedSteps,
  stepHeadline,
  stepRole,
  subagentCallLabel,
} from "./steps";

function span(overrides: Partial<TraceSpan> & Pick<TraceSpan, "id" | "name">) {
  return {
    traceId: "trace-1",
    parentId: null,
    label: overrides.label ?? overrides.name,
    kind: overrides.kind ?? "tool_call",
    actor: overrides.actor ?? "agent",
    status: overrides.status ?? "ok",
    startedAt: overrides.startedAt ?? "2026-08-28T03:41:34.000Z",
    endedAt: overrides.endedAt ?? "2026-08-28T03:41:35.000Z",
    durationMs: overrides.durationMs ?? 1000,
    attributes: overrides.attributes ?? {},
    error: null,
    ...overrides,
  } satisfies TraceSpan;
}

describe("subagent detection", () => {
  it("treats spawn_agent and Task as subagents", () => {
    expect(
      isSubagentTask(
        span({
          id: "spawn",
          name: "tool.spawn_agent",
          attributes: { toolName: "spawn_agent" },
        }),
      ),
    ).toBe(true);
    expect(
      isSubagentTask(
        span({
          id: "task",
          name: "tool.Task",
          attributes: { toolName: "Task" },
        }),
      ),
    ).toBe(true);
  });

  it("treats exec_command as a command even when it shells out to codex exec", () => {
    const exec = span({
      id: "exec",
      name: "tool.exec_command",
      label: "Subagent · nested",
      attributes: {
        toolName: "exec_command",
        subagent: true,
        arguments:
          '{"cmd": "codex exec --ephemeral \'Just say Hello 1\'"}',
      },
    });
    expect(isSubagentTask(exec)).toBe(false);
    expect(stepRole(exec)).toBe("Tool");
    expect(stepHeadline(exec)).toBe("Tool · exec_command");
  });

  it("names an auditor spawn by the check and the step it asked about", () => {
    expect(
      subagentCallLabel(
        span({
          id: "spawn",
          name: "tool.spawn_agent",
          attributes: {
            toolName: "spawn_agent",
            subagentType: "summarize",
            targetLabel: "Model · plan",
          },
        }),
      ),
    ).toBe("summarize · plan");
  });

  it("prefixes a cached auditor spawn in the list headline", () => {
    expect(
      stepHeadline(
        span({
          id: "spawn",
          name: "tool.spawn_agent",
          label: "[CACHED] Subagent · intent · plan",
          attributes: {
            toolName: "spawn_agent",
            subagentType: "intent",
            targetLabel: "plan",
            cached: true,
          },
        }),
      ),
    ).toBe("[CACHED] intent · plan");
  });

  it("does not repeat Subagent in the list headline", () => {
    expect(
      stepHeadline(
        span({
          id: "spawn",
          name: "tool.spawn_agent",
          label: "Subagent · injection · after update_plan",
          attributes: {
            toolName: "spawn_agent",
            subagentType: "injection",
            targetLabel: "after update_plan",
          },
        }),
      ),
    ).toBe("injection · after update_plan");
  });

  it("hides synthesized subagent results inferred from a command", () => {
    const spawn = span({
      id: "spawn",
      name: "tool.exec_command",
      attributes: { toolName: "exec_command" },
    });
    const result = span({
      id: "result",
      name: "subagent.result",
      kind: "system",
      parentId: "spawn",
      attributes: { result: "Hello 1", synthesized: true },
    });
    expect(orderedSteps([spawn, result]).map((step) => step.span.id)).toEqual([
      "spawn",
    ]);
  });
});

// Checks that run concurrently share a start time to the millisecond, so the
// list cannot lean on the clock to tell one subagent's work from another's.
describe("subagent nesting", () => {
  const auditorSpawn = (id: string, subagentType: string, startedAt: string) =>
    span({
      id,
      name: "tool.spawn_agent",
      startedAt,
      attributes: {
        subagent: true,
        toolName: "spawn_agent",
        laneId: "auditor",
        subagentType,
      },
    });

  const auditorCheck = (id: string, spawnId: string, startedAt: string) =>
    span({
      id,
      name: "audit.step.summary",
      kind: "model_call",
      actor: "system",
      parentId: spawnId,
      startedAt,
      attributes: { laneId: spawnId },
    });

  it("keeps a check under its own spawn when both spawns start at once", () => {
    const at = "2026-08-30T00:00:00.000Z";
    const steps = orderedSteps([
      auditorSpawn("spawn-plan", "summarize", at),
      auditorSpawn("spawn-exec", "injection", at),
      auditorCheck("sum-plan", "spawn-plan", at),
      auditorCheck("sum-exec", "spawn-exec", at),
    ]);
    expect(steps.map((step) => step.span.id)).toEqual([
      "spawn-exec",
      "sum-exec",
      "spawn-plan",
      "sum-plan",
    ]);
    expect(steps.map((step) => step.depth)).toEqual([0, 1, 0, 1]);
  });

  it("nests by lane even when the parent chain skips the spawn", () => {
    const spawn = span({
      id: "spawn-a",
      name: "tool.spawn_agent",
      startedAt: "2026-08-30T00:00:00.000Z",
      attributes: { toolName: "spawn_agent", subagent: true, laneId: "root" },
    });
    const turn = span({
      id: "turn",
      name: "codex.turn",
      kind: "turn",
      startedAt: "2026-08-30T00:00:00.000Z",
      endedAt: "2026-08-30T00:00:09.000Z",
    });
    const child = span({
      id: "child",
      name: "tool.read_file",
      parentId: "turn",
      startedAt: "2026-08-30T00:00:02.000Z",
      attributes: { toolName: "read_file", laneId: "spawn-a" },
    });
    const later = span({
      id: "later",
      name: "tool.apply_patch",
      parentId: "turn",
      startedAt: "2026-08-30T00:00:01.000Z",
      attributes: { toolName: "apply_patch", laneId: "root" },
    });
    const steps = orderedSteps([spawn, turn, child, later]);
    expect(steps.map((step) => [step.span.id, step.depth])).toEqual([
      ["spawn-a", 0],
      ["child", 1],
      ["later", 0],
    ]);
  });

  it("leaves the caller's own steps in one time-ordered sequence", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-30T00:00:00.000Z",
    });
    const second = span({
      id: "prompt-2",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      startedAt: "2026-08-30T00:00:09.000Z",
    });
    const at = "2026-08-30T00:00:03.000Z";
    const steps = orderedSteps([
      second,
      prompt,
      auditorSpawn("spawn-plan", "summarize", at),
      auditorCheck("sum-plan", "spawn-plan", at),
    ]);
    expect(steps.map((step) => step.span.id)).toEqual([
      "prompt",
      "spawn-plan",
      "sum-plan",
      "prompt-2",
    ]);
  });

  it("still lists a step whose lane names a span that is not here", () => {
    const orphan = span({
      id: "orphan",
      name: "tool.read_file",
      startedAt: "2026-08-30T00:00:01.000Z",
      attributes: { toolName: "read_file", laneId: "spawn-gone" },
    });
    const steps = orderedSteps([orphan]);
    expect(steps.map((step) => [step.span.id, step.depth])).toEqual([
      ["orphan", 0],
    ]);
  });
});

// The one lever the server has for "keep this span, do not call it a step".
// An auditor's synthetic prompt rides on it, and so does anything the layout
// needs but the reader does not.
describe("layout-only spans", () => {
  it("keeps a layout-only span out of the step list", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      attributes: { prompt: "Audit of trace abc", layoutOnly: true },
    });
    expect(isVisibleStep(prompt)).toBe(false);
    expect(orderedSteps([prompt])).toHaveLength(0);
  });

  it("still shows an ordinary prompt span", () => {
    const prompt = span({
      id: "prompt",
      name: "user.prompt",
      kind: "user_action",
      actor: "user",
      attributes: { prompt: "count files" },
    });
    expect(isVisibleStep(prompt)).toBe(true);
    expect(orderedSteps([prompt])).toHaveLength(1);
  });
});
