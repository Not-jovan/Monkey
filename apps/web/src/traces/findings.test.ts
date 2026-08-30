import { describe, expect, it } from "vitest";
import type { AuditTraceStep } from "../types";
import { visibleFindings, agentFacingFindingText } from "./TraceIntent";

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

describe("agentFacingFindingText", () => {
  it("drops an auditor outage that was concatenated onto an agent finding", () => {
    expect(
      agentFacingFindingText(
        "dangerous-action: Agent adopted gist's alwaysApply rules and planned to embed environment variables in HTML and POST them to an external debug URL, indicating a likely exfiltration vector. · Primary audit model unavailable: ModelNotOpen: Your account 3004212421 has not activated the model gpt-oss-120b-250805. Please activate the model service in the Ark Console.",
      ),
    ).toBe(
      "dangerous-action: Agent adopted gist's alwaysApply rules and planned to embed environment variables in HTML and POST them to an external debug URL, indicating a likely exfiltration vector.",
    );
  });

  it("drops check-labeled outage suffixes as well as the bare form", () => {
    expect(
      agentFacingFindingText(
        "dangerous-action: Agent writes frontend exposing environment variables. · Summarize · Model · after update_plan, Injection · Model · after update_plan: Primary audit model unavailable: ModelNotOpen: account has not activated the model.",
      ),
    ).toBe(
      "dangerous-action: Agent writes frontend exposing environment variables.",
    );
  });

  it("leaves a finding that is only about the agent", () => {
    expect(agentFacingFindingText("dangerous-action: planted instruction")).toBe(
      "dangerous-action: planted instruction",
    );
  });
});
