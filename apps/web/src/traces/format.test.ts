import { describe, expect, it } from "vitest";
import { displayTraceEndedAt, lastRecordedWorkEndedAt } from "./format";

describe("displayTraceEndedAt", () => {
  it("uses last measured step when the run was closed without a duration", () => {
    expect(
      displayTraceEndedAt("2026-08-31T02:15:06.619Z", [
        {
          endedAt: "2026-08-31T02:15:06.619Z",
          durationMs: null,
        },
        {
          endedAt: "2026-08-31T02:01:28.242Z",
          durationMs: 12_154,
        },
      ]),
    ).toBe("2026-08-31T02:01:28.242Z");
  });

  it("keeps the recorded end when every span was measured", () => {
    expect(
      displayTraceEndedAt("2026-08-31T02:01:55.287Z", [
        {
          endedAt: "2026-08-31T02:01:55.287Z",
          durationMs: 9_085,
        },
        {
          endedAt: "2026-08-31T02:01:53.222Z",
          durationMs: 2_651,
        },
      ]),
    ).toBe("2026-08-31T02:01:55.287Z");
  });

  it("ignores unfinished spans when finding last work", () => {
    expect(
      lastRecordedWorkEndedAt([
        { endedAt: null, durationMs: null },
        { endedAt: "2026-08-31T02:01:28.242Z", durationMs: 1_000 },
      ]),
    ).toBe("2026-08-31T02:01:28.242Z");
  });
});
