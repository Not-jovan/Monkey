import { describe, expect, it } from "vitest";
import type { AuditTraceStep } from "../types";
import { healthCopy } from "./TraceAuditor";

function note(finding: string, id = finding): AuditTraceStep {
  return {
    id,
    traceId: "trace-1",
    agentId: "agent-1",
    spanId: null,
    intentId: "",
    type: "error",
    category: "audit-health",
    finding,
  };
}

const OUTAGE = "The auditor could not complete: ep-primary does not exist";

describe("healthCopy", () => {
  // Every audited step reports the same outage separately, and the banner used
  // to print all of them: a ten-step run showed one sentence ten times.
  it("collapses the same note from every step into one counted sentence", () => {
    const copy = healthCopy("failed", [
      note(OUTAGE, "a"),
      note(OUTAGE, "b"),
      note(OUTAGE, "c"),
    ]);

    expect(copy.body).toBe(OUTAGE + " (on 3 audited steps)");
  });

  it("leaves a note reported by a single step uncounted", () => {
    const copy = healthCopy("failed", [note(OUTAGE)]);

    expect(copy.body).toBe(OUTAGE);
  });

  // Collapsing must not swallow a second, different reason the auditor failed.
  it("keeps notes that say different things", () => {
    const copy = healthCopy("degraded", [
      note("Primary model unavailable.", "a"),
      note("The verdict was unparseable.", "b"),
    ]);

    expect(copy.body).toContain("Primary model unavailable.");
    expect(copy.body).toContain("The verdict was unparseable.");
  });

  it("falls back to the standing copy when nothing was recorded", () => {
    expect(healthCopy("failed", []).body).toContain(
      "Neither audit model produced a verdict",
    );
    expect(healthCopy("degraded", []).body).toContain(
      "A secondary model still produced a verdict",
    );
    expect(healthCopy("ok", [note(OUTAGE)]).body).toBe(
      "The primary audit model judged this run.",
    );
  });
});
