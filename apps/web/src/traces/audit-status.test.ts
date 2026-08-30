import { describe, expect, it } from "vitest";
import { isSuccessfulAudit } from "./audit-status";

describe("isSuccessfulAudit", () => {
  it("is false until a pass has finished", () => {
    expect(
      isSuccessfulAudit({ auditComplete: false, auditHealth: "ok" }),
    ).toBe(false);
  });

  it("is true when the primary model produced a verdict", () => {
    expect(
      isSuccessfulAudit({ auditComplete: true, auditHealth: "ok" }),
    ).toBe(true);
  });

  // A fallback still judged the run. That is not the same as never finishing.
  it("is true when a fallback model still produced a verdict", () => {
    expect(
      isSuccessfulAudit({ auditComplete: true, auditHealth: "degraded" }),
    ).toBe(true);
  });

  it("is false when neither model produced a verdict", () => {
    expect(
      isSuccessfulAudit({ auditComplete: true, auditHealth: "failed" }),
    ).toBe(false);
  });
});
