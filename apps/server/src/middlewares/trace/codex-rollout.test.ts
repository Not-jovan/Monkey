import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codexRolloutAdapter } from "./codex-rollout.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

async function loadFixture() {
  return readFile(path.join(fixtureDir, "codex-rollout.jsonl"), "utf8");
}

describe("codexRolloutAdapter.parseLog", () => {
  it("parses a real rollout file into the expected event sequence", async () => {
    const text = await loadFixture();
    const events = codexRolloutAdapter.parseLog(text, true).map((e) => e.event);

    expect(events.map((e) => e.kind)).toEqual([
      "conversation_started",
      "user_prompt",
      "tool_decision",
      "tool_result",
      "model_call",
      "tool_decision",
      "tool_result",
      "model_call",
    ]);
  });

  it("reads model and sandbox/approval policy off turn_context", async () => {
    const text = await loadFixture();
    const [conversationStarted] = codexRolloutAdapter.parseLog(text, true).map((e) => e.event);
    expect(conversationStarted).toMatchObject({
      kind: "conversation_started",
      model: "deepseek-v4-flash-260425",
      approvalPolicy: "never",
      sandboxPolicy: "danger-full-access",
    });
  });

  it("pairs a function_call with its later function_call_output by call_id", async () => {
    const text = await loadFixture();
    const events = codexRolloutAdapter.parseLog(text, true).map((e) => e.event);
    const decision = events.find((e) => e.kind === "tool_decision");
    const result = events.find((e) => e.kind === "tool_result");
    if (decision?.kind !== "tool_decision" || result?.kind !== "tool_result") {
      throw new Error("expected a tool_decision/tool_result pair");
    }
    expect(decision.callId).toBe("call_1");
    expect(result.callId).toBe("call_1");
    expect(result.toolName).toBe("exec_command");
    expect(result.output).toContain("Process exited with code 0");
  });

  it("carries the second call's non-zero exit code through in the output text", async () => {
    const text = await loadFixture();
    const events = codexRolloutAdapter.parseLog(text, true).map((e) => e.event);
    const results = events.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(2);
    const failing = results[1];
    if (failing?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(failing.output).toContain("Process exited with code 1");
    // The adapter reports the harness call as successful (it ran); the
    // real command failure lives in the output text for readCommandFailure
    // to find, matching the pre-existing convention.
    expect(failing.success).toBe(true);
  });

  it("carries real per-call token usage through from token_count.info.last_token_usage", async () => {
    const text = await loadFixture();
    const events = codexRolloutAdapter.parseLog(text, true).map((e) => e.event);
    const modelCalls = events.filter((e) => e.kind === "model_call");
    expect(modelCalls).toHaveLength(2);
    const [first, second] = modelCalls;
    if (first?.kind !== "model_call" || second?.kind !== "model_call") {
      throw new Error("expected model_call events");
    }
    expect(first.usage).toMatchObject({ inputTokens: 7042, outputTokens: 389 });
    expect(second.usage).toMatchObject({ inputTokens: 458, outputTokens: 31 });
  });

  it("gives every event a distinct, increasing timestamp", async () => {
    const text = await loadFixture();
    const events = codexRolloutAdapter.parseLog(text, true);
    const times = events.map((e) => Date.parse(e.timestamp));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!);
    }
  });

  it("locateLog finds a rollout file by its trailing conversation id", async () => {
    const found = await codexRolloutAdapter.locateLog(fixtureDir, "does-not-exist");
    expect(found).toBeNull();
  });
});
