import { describe, expect, it } from "vitest";
import { parseClaudeCodeEvent } from "./claude-code-events.js";

describe("claude code event schemas", () => {
  it("parses a tool decision and lowercases the decision", () => {
    const parsed = parseClaudeCodeEvent({
      "event.name": "tool_decision",
      "session.id": "session-1",
      tool_name: "Bash",
      tool_use_id: "call_1",
      decision: "Accept",
    });
    expect(parsed).not.toBeNull();
    if (parsed?.event["event.name"] !== "tool_decision") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.decision).toBe("accept");
    expect(parsed.common["session.id"]).toBe("session-1");
  });

  it("coerces string-typed numbers", () => {
    const parsed = parseClaudeCodeEvent({
      "event.name": "tool_result",
      tool_name: "Bash",
      tool_use_id: "call_1",
      duration_ms: "114",
      success: "true",
    });
    if (parsed?.event["event.name"] !== "tool_result") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.duration_ms).toBe(114);
  });

  it("reads token counts from an api_request event", () => {
    const parsed = parseClaudeCodeEvent({
      "event.name": "api_request",
      "session.id": "session-1",
      input_tokens: "7019",
      output_tokens: "269",
    });
    if (parsed?.event["event.name"] !== "api_request") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.input_tokens).toBe(7019);
    expect(parsed.event.output_tokens).toBe(269);
  });

  it("returns null for unknown event names instead of guessing", () => {
    expect(
      parseClaudeCodeEvent({ "event.name": "borrowed_future_event" }),
    ).toBeNull();
  });
});
