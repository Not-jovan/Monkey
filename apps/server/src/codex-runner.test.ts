import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  errorEvidence,
  parseCodexEventLine,
  readStreamError,
  type ParsedEvents,
} from "./codex-runner.js";

// The runner and the trace service disagreed about this: only the trace side
// counted turn.failed, so the same run could report two different error counts,
// and errorEvidence could miss the event that said what actually went wrong.
// One definition now, exercised from the side that used to be the narrower one.
describe("readStreamError", () => {
  it("reads both shapes Codex uses to report a failure", () => {
    expect(readStreamError({ type: "error", message: "boom" })).toBe("boom");
    expect(readStreamError({ type: "error", error: "boom" })).toBe("boom");
    expect(readStreamError({ type: "error" })).toBe(
      "Codex reported an unknown error",
    );
    expect(readStreamError({ type: "turn.failed", error: "stream reset" })).toBe(
      "stream reset",
    );
    expect(
      readStreamError({ type: "turn.failed", error: { message: "reset" } }),
    ).toBe("reset");
    expect(readStreamError({ type: "turn.failed" })).toBe(
      "The Codex turn failed",
    );
  });

  it("says nothing about events that are not failures", () => {
    expect(readStreamError({ type: "turn.completed" })).toBeNull();
    expect(readStreamError({ type: "item.completed" })).toBeNull();
  });

  it("collects turn.failed into the runner's own error list", () => {
    const parsed: ParsedEvents = {
      messages: [],
      threadId: null,
      usage: null,
      errors: [],
    };
    parseCodexEventLine('{"type":"error","message":"npm timeout"}', parsed);
    parseCodexEventLine(
      '{"type":"turn.failed","error":{"message":"stream reset"}}',
      parsed,
    );
    expect(parsed.errors).toEqual(["npm timeout", "stream reset"]);
    // errorEvidence reads the last one, so a turn.failed is no longer passed
    // over in favour of stderr.
    expect(errorEvidence(parsed.errors, "some stderr")).toBe("stream reset");
  });
});

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
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
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});
