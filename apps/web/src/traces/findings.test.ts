import { describe, expect, it } from "vitest";
import type { AuditTraceStep } from "../types";
import { visibleFindings } from "./TraceIntent";

function finding(
  category: AuditTraceStep["category"],
  overrides: Partial<AuditTraceStep> = {},
) {
  return {
    id: category + "-1",
    traceId: "trace-1",
    agentId: "agent-1",
    spanId: null,
    intentId: "",
    type: "warning",
    category,
    finding: "something happened",
    ...overrides,
  } satisfies AuditTraceStep;
}

describe("visibleFindings", () => {
  it("hides audit-health beside findings about the agent", () => {
    const shown = visibleFindings([
      finding("security"),
      finding("audit-health"),
    ]);

    expect(shown.map((entry) => entry.category)).toEqual(["security"]);
  });

  // The audit of the auditor produces audit-health findings and almost nothing
  // else, so applying the default filter to it renders a heading above nothing.
  it("keeps audit-health when it is the subject", () => {
    const metaAudit = [
      finding("audit-health", { finding: "Unsupported finding: …" }),
      finding("audit-health", { type: "suspicion", finding: "Possibly missed: …" }),
    ];

    expect(visibleFindings(metaAudit, true)).toHaveLength(2);
    expect(visibleFindings(metaAudit)).toHaveLength(0);
  });
});
