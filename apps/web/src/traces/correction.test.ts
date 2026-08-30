import { describe, expect, it } from "vitest";
import type { IntentCorrection } from "../types";
import {
  correctedFindingIds,
  correctionsForTrace,
  displayedConstraints,
} from "./correction";

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

describe("displayedConstraints", () => {
  it("adds active human corrections to the derived constraints", () => {
    expect(
      displayedConstraints(["Stay in the workspace."], [correction()]),
    ).toEqual([
      { text: "Stay in the workspace.", humanCorrection: false },
      { text: "Do not read .env files.", humanCorrection: true },
    ]);
  });

  it("does not duplicate a correction already derived by the auditor", () => {
    expect(
      displayedConstraints(["Do not read .env files"], [correction()]),
    ).toEqual([
      { text: "Do not read .env files", humanCorrection: true },
    ]);
  });

  it("removes undone corrections from the displayed constraints", () => {
    expect(
      displayedConstraints([], [
        correction({ revertedAt: "2026-08-30T01:00:00.000Z" }),
      ]),
    ).toEqual([]);
  });
});

describe("correctionsForTrace", () => {
  it("keeps correction evidence on the run where it was authored", () => {
    const first = correction({ traceId: "trace-1" });
    const second = correction({ id: "second", traceId: "trace-2" });

    expect(correctionsForTrace([first, second], "trace-1")).toEqual([first]);
    expect(correctionsForTrace([first, second], "trace-2")).toEqual([second]);
  });

  it("does not let another run's correction mark this run's findings as corrected", () => {
    const otherRunCorrection = correction({
      traceId: "trace-2",
      findingIds: ["finding-on-this-run"],
    });

    const thisRunCorrections = correctionsForTrace(
      [otherRunCorrection],
      "trace-1",
    );

    expect(thisRunCorrections).toEqual([]);
    expect(correctedFindingIds(thisRunCorrections).has("finding-on-this-run")).toBe(
      false,
    );
  });
});
