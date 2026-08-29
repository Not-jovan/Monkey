import { describe, expect, it } from "vitest";
import { parseCodexEvent } from "./codex-events.js";

describe("codex event schemas", () => {
  it("parses a tool decision and normalizes the capitalized source Codex emits", () => {
    const parsed = parseCodexEvent({
      "event.name": "codex.tool_decision",
      "conversation.id": "conv-1",
      tool_name: "exec_command",
      call_id: "call_1",
      decision: "approved",
      source: "Config",
    });
    expect(parsed).not.toBeNull();
    if (parsed?.event["event.name"] !== "codex.tool_decision") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.source).toBe("config");
    expect(parsed.common["conversation.id"]).toBe("conv-1");
  });

  it("coerces the string-typed numbers Codex sends", () => {
    const parsed = parseCodexEvent({
      "event.name": "codex.tool_result",
      tool_name: "exec_command",
      call_id: "call_1",
      duration_ms: "114",
      success: "true",
      output: "done",
    });
    if (parsed?.event["event.name"] !== "codex.tool_result") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.duration_ms).toBe(114);
  });

  it("accepts mcp_servers as the comma-joined string seen on the wire", () => {
    const parsed = parseCodexEvent({
      "event.name": "codex.conversation_starts",
      provider_name: "Volcengine Ark",
      mcp_servers: "alpha,beta",
    });
    if (parsed?.event["event.name"] !== "codex.conversation_starts") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.mcp_servers).toEqual(["alpha", "beta"]);

    const empty = parseCodexEvent({
      "event.name": "codex.conversation_starts",
      provider_name: "Volcengine Ark",
      mcp_servers: "",
    });
    if (empty?.event["event.name"] !== "codex.conversation_starts") {
      throw new Error("wrong variant");
    }
    expect(empty.event.mcp_servers).toEqual([]);
  });

  it("reads token counts from response.completed stream events", () => {
    const parsed = parseCodexEvent({
      "event.name": "codex.sse_event",
      "event.kind": "response.completed",
      input_token_count: "7019",
      output_token_count: "269",
      reasoning_token_count: "21",
    });
    if (parsed?.event["event.name"] !== "codex.sse_event") {
      throw new Error("wrong variant");
    }
    expect(parsed.event.input_token_count).toBe(7019);
    expect(parsed.event.reasoning_token_count).toBe(21);
  });

  it("returns null for unknown event names instead of guessing", () => {
    expect(
      parseCodexEvent({ "event.name": "codex.borrowed_future_event" }),
    ).toBeNull();
  });
});
