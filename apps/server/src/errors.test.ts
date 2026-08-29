import { describe, expect, it } from "vitest";
import { runFailureDetail } from "./errors.js";

describe("runFailureDetail", () => {
  // Combines rather than picks: a runtime often reports the real cause on an
  // earlier event and a generic code last, so keeping only the final entry
  // discards the useful half.
  it("keeps the most recent reported errors together", () => {
    expect(runFailureDetail(["authentication_failed", "error_during_execution"], "")).toBe(
      "authentication_failed · error_during_execution",
    );
  });

  it("keeps at most the last three, oldest dropped first", () => {
    const detail = runFailureDetail(["one", "two", "three", "four"], "");
    expect(detail).toBe("two · three · four");
    expect(detail).not.toContain("one");
  });

  it("de-duplicates repeated reports", () => {
    expect(runFailureDetail(["same", "same", "same"], "")).toBe("same");
  });

  it("includes stderr alongside reported errors rather than instead of them", () => {
    expect(runFailureDetail(["reported"], "boom")).toBe("reported · stderr: boom");
  });

  it("falls back to stderr when the runtime reported nothing", () => {
    expect(runFailureDetail([], "  boom  ")).toBe("stderr: boom");
  });

  // The regression this helper exists for: `errors.at(-1) ?? stderr.trim() ??
  // "No error detail"` returned "" for an empty stderr, because ?? only falls
  // through on null/undefined. That produced bare "exited with code 1:"
  // messages with the detail silently missing.
  it("returns a real message when stderr is empty rather than an empty string", () => {
    expect(runFailureDetail([], "")).toBe("No error detail");
    expect(runFailureDetail([], "   \n  ")).toBe("No error detail");
  });

  it("ignores blank reported errors", () => {
    expect(runFailureDetail(["   "], "real stderr")).toBe("stderr: real stderr");
  });

  it("truncates a long stderr to its tail", () => {
    const detail = runFailureDetail([], "x".repeat(5000) + "TAIL_MARKER");
    expect(detail).toContain("TAIL_MARKER");
    expect(detail.length).toBeLessThan(1000);
  });
});
