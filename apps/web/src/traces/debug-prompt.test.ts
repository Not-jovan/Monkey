import { describe, expect, it } from "vitest";
import { debugPrompt } from "./debug-prompt";

const agentRun = {
  origin: "http://localhost:3000",
  traceId: "run-1",
  agentId: "agent-1",
  auditOf: null,
  auditTraceId: "audit-1",
};

describe("debugPrompt", () => {
  it("fills this run's ids into the trace and agent APIs", () => {
    const prompt = debugPrompt(agentRun);
    expect(prompt.startsWith("Use when debugging,\n")).toBe(true);
    expect(prompt).toContain(
      "- GET http://localhost:3000/api/traces/run-1/ai | Use when you need the compressed case file for this run (diagnosis, trajectory, findings). Start here",
    );
    expect(prompt).toContain(
      "- GET http://localhost:3000/api/runs/run-1 | Use when you need run status, output, error, and attributed failure",
    );
    expect(prompt).toContain(
      "- GET http://localhost:3000/api/agents/agent-1/traces/ai | Use when listing this agent's runs as a triage index. Query blame=agent or status=failed",
    );
    expect(prompt).toContain(
      "- GET http://localhost:3000/api/traces/audit-1/ai | Use when you need the auditor's own case file",
    );
  });

  it("omits the run record when this page is itself an auditor", () => {
    const prompt = debugPrompt({
      ...agentRun,
      traceId: "audit-1",
      auditOf: "run-1",
      auditTraceId: null,
    });
    expect(prompt).not.toContain("/api/runs/");
    expect(prompt).not.toContain("/api/traces/audit-1/ai | Use when you need the auditor");
  });

  it("strips a trailing slash from the origin", () => {
    const prompt = debugPrompt({ ...agentRun, origin: "http://localhost:3000/" });
    expect(prompt).toContain("GET http://localhost:3000/api/traces/run-1/ai");
    expect(prompt).not.toContain("http://localhost:3000//api/");
  });
});
