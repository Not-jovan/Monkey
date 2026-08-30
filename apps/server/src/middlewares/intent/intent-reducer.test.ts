import { describe, expect, it } from "vitest";
import type { IntentClassification } from "./intent-classifier.js";
import { IntentReducer, rebase } from "./intent-reducer.js";
import type { IntentState } from "./intent-model.js";

const INSTRUCTIONS = "You are to build an end to end application";

function state(overrides: Partial<IntentState> = {}): IntentState {
  return {
    instructions: INSTRUCTIONS,
    objective: INSTRUCTIONS,
    extended: [],
    ...overrides,
  };
}

function classification(
  overrides: Partial<IntentClassification> = {},
): IntentClassification {
  return {
    classification: "INTENT_UPDATE",
    reason: "durable rule",
    extendedIntent: [],
    removedIntent: [],
    objective: null,
    ...overrides,
  };
}

describe("rebase", () => {
  it("seeds objective from current instructions when there is no prior", () => {
    expect(rebase(INSTRUCTIONS, null)).toEqual({
      instructions: INSTRUCTIONS,
      objective: INSTRUCTIONS,
      extended: [],
    });
  });

  it("keeps prior constraints and follows an in-sync objective onto new instructions", () => {
    const prior = state({
      instructions: "Build a todo app",
      objective: "Build a todo app",
      extended: ["Do not write tests."],
    });
    expect(rebase("Build a notes app", prior)).toEqual({
      instructions: "Build a notes app",
      objective: "Build a notes app",
      extended: ["Do not write tests."],
    });
  });

  it("does not overwrite a diverged objective when instructions change", () => {
    const prior = state({
      instructions: "Build a todo app",
      objective: "Build a calendar instead",
      extended: ["Use TypeScript."],
    });
    expect(rebase("Different instructions", prior).objective).toBe(
      "Build a calendar instead",
    );
  });
});

describe("IntentReducer", () => {
  it("seeds from instructions when classify reports no change", async () => {
    const reducer = new IntentReducer(async () =>
      classification({ classification: "NO_CHANGE", reason: "work" }),
    );
    const result = await reducer.reduce({
      instructions: INSTRUCTIONS,
      prior: null,
      message: "Build a todo list in Express.",
    });
    expect(result.state.objective).toBe(INSTRUCTIONS);
    expect(result.state.extended).toEqual([]);
    expect(result.kind).toBe("seed");
  });

  it("merges newly classified constraints onto the current instructions", async () => {
    const reducer = new IntentReducer(async () =>
      classification({
        extendedIntent: [
          "Build a todo list application using Express.",
          "Do not write tests.",
        ],
      }),
    );
    const result = await reducer.reduce({
      instructions: INSTRUCTIONS,
      prior: null,
      message:
        "Build a todo list application in Express. Do not write tests.",
    });
    expect(result.state.objective).toBe(INSTRUCTIONS);
    expect(result.state.extended).toEqual([
      "Build a todo list application using Express.",
      "Do not write tests.",
    ]);
    expect(result.addedConstraints).toHaveLength(2);
    expect(result.kind).toBe("classified");
  });

  it("removes a prior constraint the message relaxes", async () => {
    const reducer = new IntentReducer(async () =>
      classification({
        reason: "relaxation",
        extendedIntent: [],
        removedIntent: ["Do not read .env files."],
      }),
    );
    const result = await reducer.reduce({
      instructions: INSTRUCTIONS,
      prior: state({ extended: ["Do not read .env files.", "Use TypeScript."] }),
      message: "Actually, you can read .env now.",
    });
    expect(result.state.extended).toEqual(["Use TypeScript."]);
    expect(result.removedConstraints).toEqual(["Do not read .env files."]);
  });

  it("replaces the objective when the classifier says it moved", async () => {
    const reducer = new IntentReducer(async () =>
      classification({
        reason: "pivot",
        objective: "Build a notes application",
      }),
    );
    const result = await reducer.reduce({
      instructions: INSTRUCTIONS,
      prior: state(),
      message: "Actually, build a notes application instead.",
    });
    expect(result.state.objective).toBe("Build a notes application");
    expect(result.previousObjective).toBe(INSTRUCTIONS);
  });

  it("does not call the classifier when there is no message", async () => {
    let called = false;
    const reducer = new IntentReducer(async () => {
      called = true;
      return classification();
    });
    const result = await reducer.reduce({
      instructions: "Audit the target agent.",
      prior: null,
      message: "  ",
    });
    expect(called).toBe(false);
    expect(result.state.objective).toBe("Audit the target agent.");
    expect(result.kind).toBe("seed");
  });
});
