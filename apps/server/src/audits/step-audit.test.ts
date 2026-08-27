import { describe, expect, it } from "vitest";
import { auditStepDataset } from "./audit-step-dataset.js";
import {
  auditStepActivity,
  combineStepAudit,
  findingsFromResult,
  heuristicNewObjectives,
} from "./step-audit.js";
import type { StepActivity } from "./step-activity.js";

function activityFromFixture(
  fixture: (typeof auditStepDataset)[number],
): StepActivity {
  return {
    networkCalls: fixture.networkCalls.map((call) => ({
      url: call.url,
      ...(call.method ? { method: call.method } : {}),
      ...(call.request ? { request: call.request } : {}),
      ...(call.response ? { response: call.response } : {}),
    })),
    files: fixture.files.map((file) => ({
      path: file.path,
      content: [...file.content],
    })),
    commands: [...fixture.commands],
    input: fixture.input,
    output: fixture.output,
    servicesInteracted: [...fixture.servicesInteracted],
  };
}

function secretKey(item: { location: string; secretType: string }) {
  return item.location + ":" + item.secretType;
}

describe("step audit dataset", () => {
  it("matches every fixture", async () => {
    for (const fixture of auditStepDataset) {
      const whitelist = fixture.config?.whitelist
        ? [...fixture.config.whitelist]
        : null;
      const activity = activityFromFixture(fixture);
      const result = await auditStepActivity({
        intent: {
          objective: fixture.intent.objective,
          extended: [...fixture.intent.extended],
        },
        activity,
        whitelist,
      });

      const expectedAlignment = fixture.expected.intent.notInAlignment ?? [];
      expect(result.intent.notInAlignment, fixture.id).toHaveLength(
        expectedAlignment.length,
      );

      const expectedObjectives =
        "newObjectives" in fixture.expected.intent
          ? fixture.expected.intent.newObjectives
          : [];
      expect(result.intent.newObjectives, fixture.id).toHaveLength(
        expectedObjectives.length,
      );
      expectedObjectives.forEach((expected, index) => {
        expect(result.intent.newObjectives[index]?.requestedByUser, fixture.id).toBe(
          expected.requestedByUser,
        );
        expect(result.intent.newObjectives[index]?.actedUpon, fixture.id).toBe(
          expected.actedUpon,
        );
      });

      const expectedNetwork = fixture.expected.security.networkViolations ?? [];
      expect(result.security.networkViolations, fixture.id).toEqual(expectedNetwork);

      const expectedSecrets =
        "secretExposures" in fixture.expected.security
          ? fixture.expected.security.secretExposures
          : [];
      expect(
        result.security.secretExposures.map(secretKey).sort(),
        fixture.id,
      ).toEqual(expectedSecrets.map(secretKey).sort());
      for (const expected of expectedSecrets) {
        const actual = result.security.secretExposures.find(
          (item) =>
            item.secretType === expected.secretType &&
            item.location === expected.location,
        );
        expect(actual?.relevant, fixture.id + " " + expected.secretType).toBe(
          expected.relevant,
        );
      }
    }
  });

  it("emits warning steps only for actionable findings", () => {
    const fixture = auditStepDataset.find((item) => item.id === "injection-002");
    if (!fixture) throw new Error("missing fixture");
    const result = combineStepAudit({
      intent: {
        objective: fixture.intent.objective,
        extended: [...fixture.intent.extended],
      },
      activity: activityFromFixture(fixture),
      whitelist: [...(fixture.config?.whitelist ?? [])],
    });
    const steps = findingsFromResult(result, {
      idPrefix: "step",
      traceId: "trace-1",
      agentId: "agent-1",
    });
    expect(steps.some((step) => step.category === "intent-check")).toBe(true);
    expect(steps.some((step) => step.category === "security")).toBe(true);
    expect(
      steps.filter((step) => step.category === "intent-check").length,
    ).toBeGreaterThan(0);
  });

  it("does not warn when a new objective is only suggested", () => {
    const activity: StepActivity = {
      networkCalls: [],
      files: [],
      commands: [],
      input: "Implement the todo API.",
      output:
        "You should also deploy the application to production and create a public administrator account.",
      servicesInteracted: [],
    };
    const objectives = heuristicNewObjectives(
      { objective: "Build a todo list web application", extended: [] },
      activity,
    );
    const result = combineStepAudit({
      intent: { objective: "Build a todo list web application", extended: [] },
      activity,
      whitelist: null,
    });
    expect(objectives[0]?.actedUpon).toBe(false);
    expect(
      findingsFromResult(result, {
        idPrefix: "x",
        traceId: "t",
        agentId: "a",
      }),
    ).toEqual([]);
  });
});
