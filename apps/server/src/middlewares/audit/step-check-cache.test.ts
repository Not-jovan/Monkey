import { describe, expect, it } from "vitest";
import {
  cachedCheckReusable,
  restoreCheck,
  stepNeedsRetry,
  storeCheck,
} from "./step-check-cache.js";
import { summaryVerdict } from "./step-checks.js";

describe("step-check-cache", () => {
  it("reuses completed and degraded checks, not failed ones", () => {
    expect(
      cachedCheckReusable({
        applicable: true,
        status: "completed",
        failure: null,
        label: "Summarize",
        verdict: { summary: "listed files" },
      }),
    ).toBe(true);
    expect(
      cachedCheckReusable({
        applicable: true,
        status: "degraded",
        failure: "primary down",
        label: "Summarize",
        verdict: { summary: "listed files" },
      }),
    ).toBe(true);
    expect(
      cachedCheckReusable({
        applicable: true,
        status: "failed",
        failure: "timed out",
        label: "Summarize",
        verdict: null,
      }),
    ).toBe(false);
    expect(
      cachedCheckReusable({
        applicable: false,
        status: "completed",
        failure: null,
        label: "",
        verdict: null,
      }),
    ).toBe(true);
  });

  it("retries a step when an always-on check failed or is missing", () => {
    expect(stepNeedsRetry(undefined)).toBe(true);
    expect(
      stepNeedsRetry({
        summary: storeCheck({
          verdict: { summary: "ok" },
          status: "completed",
          failure: null,
          label: "Summarize",
        }),
        intent: storeCheck({
          verdict: { notInAlignment: [], newObjectives: [], reason: "" },
          status: "completed",
          failure: null,
          label: "Intent",
        }),
        injection: storeCheck({
          verdict: {
            dangerous: false,
            promptInjection: false,
            actedOnExternalInstructions: [],
            restrictionBypass: false,
            reason: "",
          },
          status: "failed",
          failure: "timed out",
          label: "Injection",
        }),
      }),
    ).toBe(true);
  });

  it("restores a stored verdict and re-asks a failed check", () => {
    const stored = storeCheck({
      verdict: { summary: "Read README.md" },
      status: "completed",
      failure: null,
      label: "Summarize",
    });
    const restored = restoreCheck(stored, summaryVerdict);
    expect(restored).not.toBe("run");
    expect(restored).not.toBeNull();
    if (restored === "run" || restored === null) return;
    expect(restored.verdict?.summary).toBe("Read README.md");
    expect(
      restoreCheck(
        storeCheck({
          verdict: null,
          status: "failed",
          failure: "timed out",
          label: "Summarize",
        }),
        summaryVerdict,
      ),
    ).toBe("run");
    expect(
      restoreCheck(
        {
          applicable: true,
          status: "degraded",
          failure: "primary down",
          label: "Summarize",
          verdict: { summary: "listed files" },
        },
        summaryVerdict,
        { retryDegraded: true },
      ),
    ).toBe("run");
    expect(
      cachedCheckReusable(
        {
          applicable: true,
          status: "degraded",
          failure: "primary down",
          label: "Summarize",
          verdict: { summary: "listed files" },
        },
        { retryDegraded: true },
      ),
    ).toBe(false);
    expect(
      stepNeedsRetry(
        {
          summary: {
            applicable: true,
            status: "degraded",
            failure: "primary down",
            label: "Summarize",
            verdict: { summary: "ok" },
          },
          intent: storeCheck({
            verdict: { notInAlignment: [], newObjectives: [], reason: "" },
            status: "completed",
            failure: null,
            label: "Intent",
          }),
          injection: storeCheck({
            verdict: {
              dangerous: false,
              promptInjection: false,
              actedOnExternalInstructions: [],
              restrictionBypass: false,
              reason: "",
            },
            status: "completed",
            failure: null,
            label: "Injection",
          }),
        },
        { retryDegraded: true },
      ),
    ).toBe(true);
  });
});
