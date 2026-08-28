import { describe, expect, it } from "vitest";
import { loadConfig, secretValues } from "../config.js";
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
      model: null as string | null,
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
      model: null as string | null,
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

  // Captured verbatim from a live failing run (Claude Code 2.1.250 in the
  // Runtime container with no usable credential). The trap is that `subtype`
  // says "success" while `is_error` says otherwise — keying off subtype alone
  // recorded this auth failure as the agent's reply.
  const liveAuthFailureResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: null,
    result: "Not logged in · Please run /login",
    session_id: "326d362f-7087-4e8e-b313-c945ce0d68bb",
    duration_ms: 104,
  };

  it("treats is_error as failure even when subtype says success", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(JSON.stringify(liveAuthFailureResult), parsed);

    expect(parsed.errors).toEqual(["Not logged in · Please run /login"]);
    // The critical part: the failure text must never be mistaken for output.
    expect(parsed.messages).toEqual([]);
  });

  it("falls back through error and terminal_reason when result is absent", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 429,
      }),
      parsed,
    );

    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("api_error");
    expect(parsed.errors[0]).toContain("429");
    expect(parsed.errors[0]).toContain("error_during_execution");
  });

  it("surfaces the bare subtype when it is the only thing reported", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(
      JSON.stringify({ type: "result", subtype: "error_during_execution" }),
      parsed,
    );
    // Still thin, but naming the subtype beats a generic "unknown error" —
    // that generic string is what made the original failure undiagnosable.
    expect(parsed.errors[0]).toBe("subtype=error_during_execution");
  });

  it("never reports an empty detail when a failure carries nothing at all", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(JSON.stringify({ type: "result", is_error: true }), parsed);
    expect(parsed.errors[0]).toBe(
      "Claude Code reported a failure with no error detail",
    );
  });

  it("captures api_retry diagnostics, the only signal on a killed run", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(
      JSON.stringify({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        error_status: 401,
        error: "authentication_failed",
        session_id: "s-1",
      }),
      parsed,
    );

    expect(parsed.errors).toEqual([
      "Claude Code API retry 3/10: authentication_failed (HTTP 401)",
    ]);
    expect(parsed.messages).toEqual([]);
  });

  // Claude Code resolves its model from the account, so config cannot know
  // it; the init event is the only authoritative report of what the session
  // actually runs on.
  it("reads the session model from the init event", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "s-1",
        model: "claude-opus-5[1m]",
        apiKeySource: "ANTHROPIC_API_KEY",
      }),
      parsed,
    );
    expect(parsed.model).toBe("claude-opus-5[1m]");
  });

  // Background work (session titles) runs on a smaller model, so taking the
  // model off api_request events would intermittently report the wrong one.
  it("ignores models named by any event other than init", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      model: null as string | null,
    };
    parseClaudeCodeEventLine(
      JSON.stringify({
        type: "assistant",
        model: "claude-haiku-4-5-20251001",
        session_id: "s-1",
      }),
      parsed,
    );
    parseClaudeCodeEventLine(
      JSON.stringify({ type: "result", subtype: "success", result: "done" }),
      parsed,
    );
    expect(parsed.model).toBeNull();
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

// Claude Code ranks ANTHROPIC_API_KEY above CLAUDE_CODE_OAUTH_TOKEN, and under
// headless `-p` a present API key is always used. Forwarding both would
// silently bill the Console credit balance instead of the subscription, so
// exactly one must ever reach the process.
describe("Claude Code credential selection", () => {
  const baseEnv = {
    NODE_ENV: "test",
    AGENT_RUNTIME: "claude-code",
    ARK_API_KEY: "ark-key",
    ARK_MODEL: "ep-test",
  } as const;

  it("forwards the API key when only that is configured", () => {
    const env = claudeCodeRuntime.processEnv(
      loadConfig({ ...baseEnv, ANTHROPIC_API_KEY: "sk-ant-key" }),
      "collector-token",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("forwards the subscription token when only that is configured", () => {
    const env = claudeCodeRuntime.processEnv(
      loadConfig({ ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
      "collector-token",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("omits the API key entirely when both are set, rather than emptying it", () => {
    const env = claudeCodeRuntime.processEnv(
      loadConfig({
        ...baseEnv,
        ANTHROPIC_API_KEY: "sk-ant-key",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      }),
      "collector-token",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    // An empty-string ANTHROPIC_API_KEY still counts as "set" to the
    // container --env passthrough, so the key must be absent, not blank.
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("masks the subscription token wherever it appears", () => {
    const config = loadConfig({ ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
    expect(secretValues(config)).toContain("oauth-token");
  });
});
