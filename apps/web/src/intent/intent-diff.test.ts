import { describe, expect, it } from "vitest";
import {
  describeChange,
  hasVisibleChange,
  intentChanges,
  isMeaningful,
  versionByTrace,
} from "./intent-diff";
import type { IntentVersionEntry } from "../types";

const OBJECTIVE = "Write and store documentation for the user.";

function version(
  id: string,
  overrides: Partial<IntentVersionEntry> = {},
): IntentVersionEntry {
  return {
    id,
    // In sync by default: the objective tracks the agent's instructions unless
    // a test deliberately moves one of them.
    instructions: OBJECTIVE,
    objective: OBJECTIVE,
    extended: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function update(
  overrides: Partial<NonNullable<IntentVersionEntry["update"]>> = {},
) {
  return {
    logs: [],
    kind: "classified" as const,
    addedConstraints: [],
    removedConstraints: [],
    previousObjective: null,
    traceId: null,
    revertedFrom: null,
    ...overrides,
  };
}

describe("intentChanges", () => {
  it("reports what each version actually changed", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", {
        extended: ["Use HTML, not Markdown."],
        update: update({
          message: "From now on, use HTML instead of Markdown.",
          reason: "durable rule",
          addedConstraints: ["Use HTML, not Markdown."],
          traceId: "run-2",
        }),
      }),
    ]);

    expect(changes).toHaveLength(2);
    expect(changes[1]?.version).toBe(2);
    expect(changes[1]?.addedConstraints).toEqual(["Use HTML, not Markdown."]);
    expect(changes[1]?.trigger).toBe("From now on, use HTML instead of Markdown.");
    expect(changes[1]?.reason).toBe("durable rule");
    expect(changes[1]?.isCurrent).toBe(true);
    expect(changes[0]?.isCurrent).toBe(false);
  });

  // Computed from the versions rather than trusted from the update record, so a
  // revert reports what it actually dropped rather than what it claimed to.
  it("derives removals from the versions themselves", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", { extended: ["Use HTML, not Markdown."] }),
      version("v3", {
        extended: [],
        update: update({ kind: "revert", revertedFrom: "v1" }),
      }),
    ]);

    expect(changes[2]?.removedConstraints).toEqual(["Use HTML, not Markdown."]);
    expect(changes[2]?.addedConstraints).toEqual([]);
    expect(changes[2]?.revertedFromVersion).toBe(1);
    expect(describeChange(changes[2]!)).toBe("Restored version 1");
  });

  it("reports an objective replacement as a before and after", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", {
        objective: "Build a calendar application",
        update: update({ previousObjective: OBJECTIVE }),
      }),
    ]);

    expect(changes[1]?.objectiveBefore).toBe(OBJECTIVE);
    expect(changes[1]?.objectiveAfter).toBe("Build a calendar application");
    expect(describeChange(changes[1]!)).toContain("Objective replaced");
  });

  // Dropping the version in force would leave the timeline with no "in force"
  // row, and make the version count disagree with the numbers on the rows.
  it("keeps the seed and the version in force, drops no-op versions between them", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2"),
      version("v3", { extended: ["Use HTML, not Markdown."] }),
    ]);
    expect(isMeaningful(changes[0]!)).toBe(true);
    expect(isMeaningful(changes[1]!)).toBe(false);
    expect(isMeaningful(changes[2]!)).toBe(true);

    // A no-op version that happens to be the newest is still kept, and keeps
    // its real version number rather than being renumbered by the filter.
    const trailing = intentChanges([
      version("v1"),
      version("v2", { extended: ["Use HTML, not Markdown."] }),
      version("v3", { extended: ["Use HTML, not Markdown."] }),
    ]);
    const shown = trailing.filter(isMeaningful);
    expect(shown).toHaveLength(3);
    expect(shown.at(-1)?.version).toBe(3);
    expect(shown.at(-1)?.isCurrent).toBe(true);
  });

  it("handles a single seeded version", () => {
    const changes = intentChanges([version("v1")]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("seed");
    expect(describeChange(changes[0]!)).toContain("Spec set");
  });

  it("survives an empty history", () => {
    expect(intentChanges([])).toEqual([]);
  });
});

describe("versionByTrace", () => {
  // What lets a message in the Playground say that it moved the spec.
  it("maps runs to the change their message caused", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", {
        extended: ["Use HTML, not Markdown."],
        update: update({ traceId: "run-2", addedConstraints: ["Use HTML, not Markdown."] }),
      }),
      // Classified as an update but changed nothing, so it must not claim a
      // message rewrote the rules.
      version("v3", {
        extended: ["Use HTML, not Markdown."],
        update: update({ traceId: "run-3" }),
      }),
    ]);
    const byTrace = versionByTrace(changes);

    expect(byTrace.get("run-2")?.version).toBe(2);
    expect(byTrace.has("run-3")).toBe(false);
    expect(byTrace.has("run-1")).toBe(false);
  });
});

describe("instructions as the source of truth", () => {
  const REVISED = "Write and store documentation, in HTML.";

  it("shows an instructions edit as its own change", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", {
        instructions: REVISED,
        objective: REVISED,
        update: update({ kind: "instructions", logs: ["Instructions changed"] }),
      }),
    ]);

    const edit = changes[1]!;
    expect(edit.instructionsBefore).toBe(OBJECTIVE);
    expect(edit.instructionsAfter).toBe(REVISED);
    // The objective moved with the instructions, so nothing has diverged.
    expect(edit.diverged).toBe(false);
    expect(hasVisibleChange(edit)).toBe(true);
    expect(describeChange(edit)).toBe(
      "Agent instructions edited; objective followed",
    );
  });

  it("marks an objective the conversation moved away from the instructions", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", {
        objective: "Build a calendar app",
        update: update({ message: "Build a calendar instead." }),
      }),
    ]);

    const pivot = changes[1]!;
    // Instructions untouched: a classification never rewrites configuration.
    expect(pivot.instructionsAfter).toBe(OBJECTIVE);
    expect(pivot.diverged).toBe(true);
    expect(pivot.objectiveBefore).toBe(OBJECTIVE);
  });

  it("describes an adoption as collapsing the two back together", () => {
    const changes = intentChanges([
      version("v1"),
      version("v2", { objective: "Build a calendar app" }),
      version("v3", {
        instructions: "Build a calendar app",
        objective: "Build a calendar app",
        update: update({ kind: "adopted", logs: ["Adopted"] }),
      }),
    ]);

    const adopted = changes[2]!;
    expect(adopted.diverged).toBe(false);
    expect(adopted.instructionsBefore).toBe(OBJECTIVE);
    expect(describeChange(adopted)).toBe(
      "Objective adopted into the agent's instructions",
    );
  });
});
