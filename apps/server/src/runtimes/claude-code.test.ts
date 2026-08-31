import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeArgs,
  parseClaudeCodeEventLine,
} from "./claude-code.js";

describe("Claude Code runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildClaudeCodeArgs(
      { prompt: "build a calculator", threadId: null },
      "acceptEdits",
    );

    expect(args).toEqual([
      "-p",
      "build a calculator",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  it("resumes a stored Claude Code session", () => {
    const args = buildClaudeCodeArgs(
      { prompt: "add tests", threadId: "session-123" },
      "bypassPermissions",
    );

    expect(args.slice(-3)).toEqual([
      "bypassPermissions",
      "--resume",
      "session-123",
    ]);
  });

  it("extracts the session, final message and usage", () => {
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
      '{"type":"system","subtype":"init","session_id":"session-123","model":"claude-sonnet"}',
      parsed,
    );
    parseClaudeCodeEventLine(
      '{"type":"result","subtype":"success","result":"Done.","usage":{"input_tokens":10,"cache_read_input_tokens":3,"output_tokens":4}}',
      parsed,
    );

    expect(parsed.threadId).toBe("session-123");
    expect(parsed.model).toBe("claude-sonnet");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 4,
    });
  });
});
