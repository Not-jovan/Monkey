import { describe, expect, it } from "vitest";
import type { AuditAttempt } from "../types";
import { attemptsOldestFirst, auditAttemptLabel } from "./audit-attempts";

describe("auditAttemptLabel", () => {
  it("numbers from the first pass and marks the current one", () => {
    expect(
      auditAttemptLabel({ number: 1, latest: false, status: "failed" }),
    ).toBe("Attempt 1 · failed");
    expect(
      auditAttemptLabel({ number: 2, latest: true, status: "completed" }),
    ).toBe("Attempt 2 · latest");
    expect(
      auditAttemptLabel({ number: 2, latest: true, status: "running" }),
    ).toBe("Attempt 2 · running · latest");
  });
});

describe("attemptsOldestFirst", () => {
  it("turns the API's newest-first list into chronological order", () => {
    const attempts: AuditAttempt[] = [
      {
        id: "second",
        status: "completed",
        startedAt: "2026-08-28T00:00:30.000Z",
        endedAt: "2026-08-28T00:00:40.000Z",
      },
      {
        id: "first",
        status: "failed",
        startedAt: "2026-08-28T00:00:10.000Z",
        endedAt: "2026-08-28T00:00:20.000Z",
      },
    ];
    expect(attemptsOldestFirst(attempts).map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
  });
});
