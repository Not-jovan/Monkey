import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../types";
import {
  isSubagentTask,
  isVisibleStep,
  orderedSteps,
  stepHeadline,
  stepRole,
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
