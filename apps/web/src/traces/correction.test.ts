import { describe, expect, it } from "vitest";
import type { IntentCorrection } from "../types";
import { correctedFindingIds } from "./TraceCorrection";

function correction(overrides: Partial<IntentCorrection> = {}): IntentCorrection {
  return {
    id: "correction-1",
    agentId: "agent-1",
    traceId: "trace-1",
    findingIds: ["finding-1"],
    correction: "Do not read .env files.",
    instructionsBefore: "Build a todo list.",
    createdAt: "2026-08-30T00:00:00.000Z",
    revertedAt: null,
    ...overrides,
  };
}

describe("correctedFindingIds", () => {
  it("collects every finding a correction was made from", () => {
    const ids = correctedFindingIds([
      correction({ findingIds: ["a", "b"] }),
      correction({ id: "second", findingIds: ["c"] }),
    ]);

    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });

  // An undone correction is no longer in force, so the findings it answered
  // are open again — marking them as handled would tell the operator a rule
  // covers them when the Agent has stopped being told it.
  it("ignores corrections that were undone", () => {
    const ids = correctedFindingIds([
      correction({ findingIds: ["a"], revertedAt: "2026-08-30T01:00:00.000Z" }),
      correction({ id: "second", findingIds: ["b"] }),
    ]);

    expect([...ids]).toEqual(["b"]);
  });

  it("is empty when nothing has been corrected", () => {
    expect(correctedFindingIds([]).size).toBe(0);
  });
});
