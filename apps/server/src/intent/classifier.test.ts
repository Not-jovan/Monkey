import { describe, expect, it } from "vitest";
import type { ArkClient } from "../audits/ark-client.js";
import { ArkApiError } from "../audits/ark-client.js";
import {
  applyIntentClassification,
  classifyIntentScope,
  intentScopeUserPrompt,
} from "./classifier.js";
import { intentScopeDataset } from "./intent-scope-dataset.js";

function fakeClient(responses: (string | Error)[]): ArkClient {
  let index = 0;
  return {
    complete: async () => {
      const next = responses[index] ?? responses[responses.length - 1];
      index += 1;
      if (next instanceof Error) throw next;
      return { content: next ?? "" };
    },
  };
}

describe("classifyIntentScope", () => {
  it("retries invalid JSON up to three times", async () => {
    const client = fakeClient([
      "not json",
      "{bad",
      '{"classification":"NO_CHANGE","reason":"work request","extendedIntent":[]}',
    ]);
    const verdict = await classifyIntentScope({
      client,
      model: "intent-model",
      originalIntent: "Build a todo list web application",
      extendedIntent: [],
      userMessage: "Build the todo list UI.",
    });
    expect(verdict.classification).toBe("NO_CHANGE");
    expect(verdict.extendedIntent).toEqual([]);
  });

  it("rejects INTENT_UPDATE without new constraints and retries", async () => {
    const client = fakeClient([
      '{"classification":"INTENT_UPDATE","reason":"maybe","extendedIntent":[]}',
      '{"classification":"INTENT_UPDATE","reason":"standing rule","extendedIntent":["Do not read .env files."]}',
    ]);
    const verdict = await classifyIntentScope({
      client,
      model: "intent-model",
      originalIntent: "Build a todo list web application",
      extendedIntent: [],
      userMessage: "Do not read from .env files.",
    });
    expect(verdict.classification).toBe("INTENT_UPDATE");
    expect(verdict.extendedIntent).toEqual(["Do not read .env files."]);
  });

  it("fails after three invalid responses", async () => {
    const client = fakeClient(["nope", "nope", "nope"]);
    await expect(
      classifyIntentScope({
        client,
        model: "intent-model",
        originalIntent: "Build a todo list web application",
        extendedIntent: [],
        userMessage: "Hello",
      }),
    ).rejects.toThrow();
  });

  it("does not retry Ark transport errors", async () => {
    const client = fakeClient([
      new ArkApiError("down", "InternalError", 500),
    ]);
    await expect(
      classifyIntentScope({
        client,
        model: "intent-model",
        originalIntent: "Build a todo list web application",
        extendedIntent: [],
        userMessage: "Hello",
      }),
    ).rejects.toThrow(/down/);
  });

  it("clears extendedIntent when the model classifies NO_CHANGE", async () => {
    const client = fakeClient([
      '{"classification":"NO_CHANGE","reason":"just work","extendedIntent":["should be dropped"]}',
    ]);
    const verdict = await classifyIntentScope({
      client,
      model: "intent-model",
      originalIntent: "Build a todo list web application",
      extendedIntent: [],
      userMessage: "Add a delete button for each todo.",
    });
    expect(verdict.extendedIntent).toEqual([]);
  });
});

describe("applyIntentClassification", () => {
  it("appends new constraints and ignores duplicates", () => {
    const next = applyIntentClassification(
      { objective: "Build a todo list web application", extended: ["Do not read .env files."] },
      {
        classification: "INTENT_UPDATE",
        reason: "new rule",
        extendedIntent: ["Do not read .env files.", "Do not use any or unknown."],
      },
    );
    expect(next.extended).toEqual([
      "Do not read .env files.",
      "Do not use any or unknown.",
    ]);
  });

  it("leaves state unchanged on NO_CHANGE", () => {
    const current = {
      objective: "Build a todo list web application",
      extended: ["Do not read .env files."],
    };
    expect(
      applyIntentClassification(current, {
        classification: "NO_CHANGE",
        reason: "work",
        extendedIntent: ["ignored"],
      }),
    ).toEqual(current);
  });

  it("merges every dataset case according to expectNewIntent", () => {
    for (const fixture of intentScopeDataset) {
      const prompt = intentScopeUserPrompt({
        originalIntent: fixture.originalIntent,
        extendedIntent: [...fixture.extendedIntent],
        userMessage: fixture.message,
      });
      expect(prompt).toContain(fixture.originalIntent);
      expect(prompt).toContain(fixture.message);

      const verdict = {
        classification: fixture.expectNewIntent
          ? ("INTENT_UPDATE" as const)
          : ("NO_CHANGE" as const),
        reason: "fixture",
        extendedIntent: fixture.expectNewIntent ? [fixture.message] : [],
      };
      const next = applyIntentClassification(
        {
          objective: fixture.originalIntent,
          extended: [...fixture.extendedIntent],
        },
        verdict,
      );
      if (fixture.expectNewIntent) {
        expect(next.extended).toContain(fixture.message);
        expect(next.extended.length).toBeGreaterThanOrEqual(
          fixture.extendedIntent.length + 1,
        );
      } else {
        expect(next.extended).toEqual([...fixture.extendedIntent]);
      }
    }
  });
});
