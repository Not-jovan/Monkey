import { describe, expect, it } from "vitest";
import { buildClaudeCodeArgs, claudeCodeRuntime, parseClaudeCodeEventLine } from "./claude-code.js";

describe("Claude Code runtime protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildClaudeCodeArgs({
      prompt: "build a calculator",
      threadId: null,
    });
    expect(args).toEqual([
      "-p",
      "build a calculator",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("resumes a stored session", () => {
    const args = buildClaudeCodeArgs({
      prompt: "add tests",
      threadId: "session-123",
    });
    expect(args.slice(-2)).toEqual(["--resume", "session-123"]);
  });

  it("extracts the session id, final message and usage from stream-json", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseClaudeCodeEventLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-123" }),
      parsed,
    );
    parseClaudeCodeEventLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done.",
        session_id: "session-123",
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("session-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
    });
  });

  it("records an error result", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    parseClaudeCodeEventLine(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        result: "Hit the turn limit",
      }),
      parsed,
    );
    expect(parsed.errors).toEqual(["Hit the turn limit"]);
  });
});

describe("Claude Code trace normalization", () => {
  it("normalizes a user prompt event", () => {
    const normalized = claudeCodeRuntime.trace.normalize({
      "event.name": "user_prompt",
      "session.id": "session-1",
      prompt_length: 12,
      prompt: "hello there",
    });
    expect(normalized).toEqual({
      kind: "user_prompt",
      promptLength: 12,
      prompt: "hello there",
    });
  });

  it("normalizes a successful api_request with inline usage", () => {
    const normalized = claudeCodeRuntime.trace.normalize({
      "event.name": "api_request",
      "session.id": "session-1",
      duration_ms: 500,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 5,
    });
    expect(normalized).toEqual({
      kind: "model_call",
      spanName: "claude_code.api_request",
      durationMs: 500,
      failed: false,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 5 },
    });
  });

  it("normalizes an api_error as a failed model call", () => {
    const normalized = claudeCodeRuntime.trace.normalize({
      "event.name": "api_error",
      "session.id": "session-1",
      duration_ms: 200,
      status_code: 500,
      error: "overloaded",
    });
    expect(normalized).toEqual({
      kind: "model_call",
      spanName: "claude_code.api_request",
      durationMs: 200,
      failed: true,
      statusCode: 500,
      attempt: undefined,
      errorMessage: "overloaded",
    });
  });

  it("collapses tool_decision to approved/denied", () => {
    const accepted = claudeCodeRuntime.trace.normalize({
      "event.name": "tool_decision",
      "session.id": "session-1",
      tool_name: "Bash",
      tool_use_id: "call-1",
      decision: "accept",
    });
    expect(accepted).toMatchObject({ kind: "tool_decision", decision: "approved" });

    const rejected = claudeCodeRuntime.trace.normalize({
      "event.name": "tool_decision",
      "session.id": "session-1",
      tool_name: "Bash",
      tool_use_id: "call-1",
      decision: "REJECT",
    });
    expect(rejected).toMatchObject({ kind: "tool_decision", decision: "denied" });
  });

  it("normalizes a tool_result, preferring tool_input over tool_parameters for arguments", () => {
    const normalized = claudeCodeRuntime.trace.normalize({
      "event.name": "tool_result",
      "session.id": "session-1",
      tool_name: "Bash",
      tool_use_id: "call-1",
      success: "true",
      duration_ms: 90,
      tool_parameters: '{"bash_command":"ls","full_command":"ls","description":"List files"}',
      tool_input: '{"command":"ls","description":"List files"}',
      tool_input_size_bytes: 64,
      tool_result_size_bytes: 57,
    });
    expect(normalized).toMatchObject({
      kind: "tool_result",
      toolName: "Bash",
      callId: "call-1",
      success: true,
      durationMs: 90,
      arguments: '{"command":"ls","description":"List files"}',
      // Confirmed absent from the wire even with OTEL_LOG_TOOL_DETAILS=1 —
      // only tool input content and sizes are ever delivered, never output.
      output: undefined,
    });
  });

  it("falls back to tool_parameters for arguments when tool_input is absent", () => {
    const normalized = claudeCodeRuntime.trace.normalize({
      "event.name": "tool_result",
      "session.id": "session-1",
      tool_name: "Bash",
      tool_use_id: "call-1",
      success: "true",
      duration_ms: 90,
      tool_parameters: '{"bash_command":"ls"}',
    });
    expect(normalized).toMatchObject({
      kind: "tool_result",
      arguments: '{"bash_command":"ls"}',
    });
  });

  it("returns null for attributes that don't parse as any known event", () => {
    expect(
      claudeCodeRuntime.trace.normalize({ "event.name": "unknown_future_event" }),
    ).toBeNull();
  });

  it("correlates on session.id, not conversation.id", () => {
    expect(claudeCodeRuntime.trace.correlationAttribute).toBe("session.id");
  });
});
