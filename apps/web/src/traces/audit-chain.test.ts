import { describe, expect, it } from "vitest";
import { auditChainLabel } from "./TraceDetailPage";

// The breadcrumb is how someone finds their way back down a stack of audits,
// so every level has to appear as its own hop. Numbering the deeper ones made
// three audits read as "Agent run › Audit › Audit ×2" — one entry standing in
// for two, which is exactly what the chain exists to spell out.
describe("auditChainLabel", () => {
  it("names the agent run at the root and every audit above it the same", () => {
    expect([0, 1, 2, 3, 7].map(auditChainLabel)).toEqual([
      "Agent run",
      "Audit",
      "Audit",
      "Audit",
      "Audit",
    ]);
  });
});
