import { describe, expect, it } from "vitest";
import { auditAction } from "./audit-action";

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
  // The automatic pass judges depth 0 and nothing else, so an Agent run is
  // only ever a way into the audit above it.
  it("offers an Agent run its audit and never a trigger", () => {
    expect(auditAction(agentRun)).toEqual({ view: "audit-1", run: false });
  });

  // The audit trace is registered when the pass opens, not when it lands, so
  // there is somewhere to go while the judging is still happening.
  it("offers the audit of an Agent run before that pass has finished", () => {
    expect(auditAction({ ...agentRun, auditComplete: false })).toEqual({
      view: "audit-1",
      run: false,
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
