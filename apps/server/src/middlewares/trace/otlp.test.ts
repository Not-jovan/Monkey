import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readOtlpLogs } from "./otlp.js";

const fixture = JSON.parse(
  await readFile(new URL("./__fixtures__/otlp-logs.json", import.meta.url), "utf8"),
) as unknown;

describe("OTLP logs reader", () => {
  it("flattens the payload captured from a live codex 0.111.0 run", () => {
    const records = readOtlpLogs(fixture);
    expect(records).not.toBeNull();
    expect(records).toHaveLength(6);
    const names = records?.map((record) => record.attributes["event.name"]);
    expect(names).toEqual([
      "codex.conversation_starts",
      "codex.user_prompt",
      "codex.api_request",
      "codex.sse_event",
      "codex.tool_decision",
      "codex.tool_result",
    ]);
    for (const record of records ?? []) {
      expect(record.attributes["conversation.id"]).toBe(
        "01a03e52-a697-79a1-b344-15a234416b01",
      );
      expect(typeof record.timestamp).toBe("string");
    }
  });

  it("converts intValue wrappers to numbers", () => {
    const records = readOtlpLogs({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "count", value: { intValue: "42" } },
                    { key: "ratio", value: { doubleValue: 0.5 } },
                    { key: "flag", value: { boolValue: true } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(records?.[0]?.attributes).toEqual({ count: 42, ratio: 0.5, flag: true });
  });

  it("rejects payloads that are not OTLP logs", () => {
    expect(readOtlpLogs({ hello: "world" })).not.toBeNull();
    expect(readOtlpLogs("nope")).toBeNull();
    expect(readOtlpLogs({ resourceLogs: "nope" })).toBeNull();
  });
});
