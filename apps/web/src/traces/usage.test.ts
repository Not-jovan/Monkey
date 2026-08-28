import { describe, expect, it } from "vitest";
import type { TraceSpan } from "../types";
import { spanUsage, usageShare } from "./usage";

function span(attributes: TraceSpan["attributes"]): TraceSpan {
  return {
    id: "span-1",
    traceId: "trace-1",
    parentId: null,
    name: "codex.api_request",
    label: "Model · plan",
    kind: "model_call",
    actor: "agent",
    status: "ok",
    startedAt: "2026-08-28T03:41:34.000Z",
    endedAt: "2026-08-28T03:41:35.000Z",
    durationMs: 1000,
    attributes,
    error: null,
  };
}

describe("spanUsage", () => {
  it("returns null when a step recorded no token counts", () => {
    expect(spanUsage(span({ toolName: "exec_command" }))).toBeNull();
  });

  it("reads the token counts stamped on a model call", () => {
    expect(
      spanUsage(
        span({
          inputTokens: 7451,
          cachedTokens: 6912,
          outputTokens: 88,
          reasoningTokens: 40,
        }),
      ),
    ).toEqual({
      inputTokens: 7451,
      cachedTokens: 6912,
      outputTokens: 88,
      reasoningTokens: 40,
      toolTokens: 0,
    });
  });

  it("uses cached tokens as a floor when input was not recorded", () => {
    expect(
      spanUsage(
        span({
          cachedTokens: 12288,
          outputTokens: 549,
          reasoningTokens: 328,
        }),
      ),
    ).toEqual({
      inputTokens: 12288,
      cachedTokens: 12288,
      outputTokens: 549,
      reasoningTokens: 328,
      toolTokens: 0,
    });
  });
});

describe("usageShare", () => {
  it("is the part of the total, clamped to 0..1", () => {
    expect(usageShare(6912, 7451)).toBeCloseTo(6912 / 7451);
    expect(usageShare(0, 100)).toBe(0);
    expect(usageShare(10, 0)).toBe(0);
    expect(usageShare(-4, 10)).toBe(0);
    expect(usageShare(20, 10)).toBe(1);
  });
});
