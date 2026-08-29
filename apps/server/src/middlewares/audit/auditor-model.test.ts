import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArkApiError, type ArkClient } from "../../ark-client.js";
import { AuditorModel, describeError, summarizeError } from "./auditor-model.js";

const verdict = z.object({ ok: z.boolean() });
const ANSWER = JSON.stringify({ ok: true });

const notActivated = (requestId: string) =>
  new ArkApiError(
    "Your account has not activated the model primary-model. " +
      "Please activate the model service in the Ark Console. Request id: " +
      requestId,
    "ModelNotOpen",
    404,
  );

// Counts the calls so a test can tell a request that was made from one the
// remembered outage skipped.
function fakeClient(): ArkClient & { models: string[] } {
  const models: string[] = [];
  return {
    models,
    complete: async ({ model }) => {
      models.push(model);
      if (model !== "primary-model") return { content: ANSWER };
      throw notActivated("request-id-" + models.length);
    },
  };
}

describe("summarizeError", () => {
  // The provider stamps a fresh id on every response, so seven checks reporting
  // one outage produced seven strings that no consumer could group.
  it("drops the per-response request id that describeError keeps", () => {
    const error = notActivated("request-id-1");

    expect(describeError(error)).toContain("Request id:");
    expect(summarizeError(error)).toBe(
      "ModelNotOpen: Your account has not activated the model primary-model. " +
        "Please activate the model service in the Ark Console.",
    );
  });

  it("reports two different outages as two different summaries", () => {
    const left = summarizeError(notActivated("aaa"));
    const right = summarizeError(
      new ArkApiError("Rate limited", "TooManyRequests", 429),
    );

    expect(left).not.toBe(right);
  });
});

describe("AuditorModel.complete", () => {
  it("gives every check the same words for one outage", async () => {
    const client = fakeClient();
    const model = new AuditorModel(client);
    const ask = () =>
      model.complete("primary-model", "fallback-model", "s", "u", verdict);

    // Concurrent, the way one step's checks actually run: all three reach the
    // provider before any of them learns the model is gone, so each is handed
    // its own request id.
    const concurrent = await Promise.all([ask(), ask(), ask()]);

    expect(new Set(concurrent.map((answer) => answer.failure)).size).toBe(1);
    expect(concurrent[0]?.status).toBe("degraded");
    expect(concurrent[0]?.failure).toBe(
      "Primary audit model unavailable: ModelNotOpen: Your account has not " +
        "activated the model primary-model. Please activate the model service " +
        "in the Ark Console.",
    );
  });

  it("repeats the remembered reason rather than a bare not-available", async () => {
    const client = fakeClient();
    const model = new AuditorModel(client);
    const first = await model.complete(
      "primary-model",
      "fallback-model",
      "s",
      "u",
      verdict,
    );
    const calls = client.models.length;

    const later = await model.complete(
      "primary-model",
      "fallback-model",
      "s",
      "u",
      verdict,
    );

    // The primary is not tried again, and what the check reports does not
    // change just because it skipped the call.
    expect(client.models.slice(calls)).not.toContain("primary-model");
    expect(later.failure).toBe(first.failure);
  });

  // The attempt is what the auditor's own span shows, and an operator taking a
  // failure to the provider needs the id the summary drops.
  it("keeps the request id on the attempt it summarised away", async () => {
    const client = fakeClient();
    const model = new AuditorModel(client);

    const answer = await model.complete(
      "primary-model",
      "fallback-model",
      "s",
      "u",
      verdict,
    );

    expect(answer.failure).not.toContain("Request id:");
    expect(
      answer.attempts.some((attempt) => attempt.error?.includes("Request id:")),
    ).toBe(true);
  });
});
