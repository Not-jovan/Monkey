import { describe, expect, it } from "vitest";
import { auditAction, showDegradedRetry } from "./audit-action";

const agentRun = {
  auditOf: null,
  status: "completed" as const,
  auditComplete: true,
  auditHealth: "ok" as const,
  auditTraceId: "audit-1",
};

const auditor = {
  ...agentRun,
  auditOf: "run-1",
  auditComplete: false,
  auditTraceId: null,
};

describe("auditAction", () => {
  it("offers an Agent run its audit and no trigger once the pass succeeded", () => {
    expect(auditAction(agentRun)).toEqual({ view: "audit-1", run: false });
  });

  it("offers a retry while an Agent run's audit has not finished", () => {
    expect(auditAction({ ...agentRun, auditComplete: false })).toEqual({
      view: "audit-1",
      run: true,
    });
  });

  it("offers a retry when an Agent run's audit failed", () => {
    expect(auditAction({ ...agentRun, auditHealth: "failed" })).toEqual({
      view: "audit-1",
      run: true,
    });
  });

  it("offers an unjudged auditor the trigger and nowhere to go", () => {
    expect(auditAction(auditor)).toEqual({ view: null, run: true });
  });

  it("sends a judged auditor on to the audit it produced", () => {
    expect(
      auditAction({
        ...auditor,
        auditComplete: true,
        auditTraceId: "audit-2",
      }),
    ).toEqual({ view: "audit-2", run: false });
  });

  // A pass that produced no verdict still wrote a trace. That trace explains
  // why it failed, and the run has still not been judged, so both stand.
  it("offers a failed audit for reading and the retry that follows it", () => {
    expect(
      auditAction({
        ...auditor,
        auditComplete: true,
        auditHealth: "failed",
        auditTraceId: "audit-2",
      }),
    ).toEqual({ view: "audit-2", run: true });
  });

  // Half a trace cannot be judged, and the automatic pass has the same rule.
  it("withholds the trigger while the auditor is still running", () => {
    expect(auditAction({ ...auditor, status: "running" })).toEqual({
      view: null,
      run: false,
    });
  });

  // Depth is the server's business. Nothing here counts the levels.
  it("treats an auditor of an auditor exactly like any other auditor", () => {
    expect(auditAction({ ...auditor, auditOf: "audit-1" })).toEqual({
      view: null,
      run: true,
    });
  });
});

describe("showDegradedRetry", () => {
  it("is true only on the auditor tab of a degraded pass", () => {
    expect(
      showDegradedRetry({ pane: "auditor", auditHealth: "degraded" }),
    ).toBe(true);
    expect(showDegradedRetry({ pane: "run", auditHealth: "degraded" })).toBe(
      false,
    );
    expect(showDegradedRetry({ pane: "auditor", auditHealth: "ok" })).toBe(
      false,
    );
    expect(showDegradedRetry({ pane: "auditor", auditHealth: "failed" })).toBe(
      false,
    );
  });
});
