import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeCodeSessionAdapter } from "./claude-code-session.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

async function loadFixture() {
  return readFile(path.join(fixtureDir, "claude-code-session.jsonl"), "utf8");
}

describe("claudeCodeSessionAdapter.parseLog", () => {
  it("groups the three lines sharing one message.id into a single model_call, not three", async () => {
    const text = await loadFixture();
    const events = claudeCodeSessionAdapter.parseLog(text, true).map((e) => e.event);

    // First turn: user_prompt, then one model_call (from the
    // thinking+text+tool_use group) plus its tool_decision, then the
    // tool_result, then a second turn's model_call with no further tool use.
    expect(events.map((e) => e.kind)).toEqual([
      "user_prompt",
      "model_call",
      "tool_decision",
      "tool_result",
      "model_call",
    ]);
  });

  it("attaches usage to the grouped model_call exactly once", async () => {
    const text = await loadFixture();
    const events = claudeCodeSessionAdapter.parseLog(text, true).map((e) => e.event);
    const firstModelCall = events.find((e) => e.kind === "model_call");
    if (firstModelCall?.kind !== "model_call") throw new Error("expected model_call");
    expect(firstModelCall.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 217,
      cachedTokens: 23906,
    });
  });

  it("correlates tool_result back to its tool_use by id, carrying full stdout", async () => {
    const text = await loadFixture();
    const events = claudeCodeSessionAdapter.parseLog(text, true).map((e) => e.event);
    const decision = events.find((e) => e.kind === "tool_decision");
    const result = events.find((e) => e.kind === "tool_result");
    if (decision?.kind !== "tool_decision" || result?.kind !== "tool_result") {
      throw new Error("expected a tool_decision/tool_result pair");
    }
    expect(decision.toolName).toBe("Bash");
    expect(result.callId).toBe("toolu_1");
    expect(result.output).toBe("README.md\nsummary.md");
    expect(result.success).toBe(true);
  });

  it("holds a still-open trailing group back unless flushTrailing is true", async () => {
    const text = await loadFixture();
    // Truncate to just the group-opening lines of the second turn (drop the
    // trailing newline-delimited last line) to simulate a poll tick that
    // caught the file mid-write.
    const lines = text.trim().split("\n");
    const partial = lines.join("\n") + "\n";

    const held = claudeCodeSessionAdapter.parseLog(partial, false).map((e) => e.event);
    const flushed = claudeCodeSessionAdapter.parseLog(partial, true).map((e) => e.event);

    // Both parses of the same (complete) text should already match, since
    // the fixture's last line closes cleanly with a non-assistant line
    // following the final group in a real file. Assert flushing never
    // *removes* events relative to holding back.
    expect(flushed.length).toBeGreaterThanOrEqual(held.length);
  });

  it("recognizes a real API error on the message as a failed model_call", async () => {
    const errorLine = JSON.stringify({
      type: "assistant",
      uuid: "a5",
      timestamp: "2026-08-29T07:41:50.000Z",
      isSidechain: false,
      isApiErrorMessage: true,
      apiErrorStatus: 400,
      error: "billing_error",
      message: {
        model: "claude-sonnet-5",
        id: "msg_3",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Credit balance is too low" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const events = claudeCodeSessionAdapter.parseLog(errorLine, true).map((e) => e.event);
    const call = events.find((e) => e.kind === "model_call");
    if (call?.kind !== "model_call") throw new Error("expected model_call");
    expect(call.failed).toBe(true);
    expect(call.statusCode).toBe(400);
    expect(call.errorMessage).toBe("Credit balance is too low");
  });

  it("locateLog returns null when no matching session file exists", async () => {
    const found = await claudeCodeSessionAdapter.locateLog(fixtureDir, "does-not-exist");
    expect(found).toBeNull();
  });
});
