import { describe, expect, it } from "vitest";
import {
  blamesAgent,
  classifyRunFailure,
  isPermanentProviderError,
  noAgentMessageFailure,
} from "./failures.js";

// The point of attribution is that only two layers mean the agent needs
// changing. These cases are the ones that would otherwise be misread as agent
// defects, so they are asserted by layer rather than by message text.
describe("classifyRunFailure", () => {
  it("attributes a sandbox denial to policy, not to the agent", () => {
    const failure = classifyRunFailure(
      'exec_command failed: SandboxDenied { message: "listen EPERM 0.0.0.0:8080" }',
      { exitCode: 1 },
    );
    expect(failure.layer).toBe("policy");
    expect(failure.kind).toBe("sandbox-denied");
    expect(blamesAgent(failure)).toBe(false);
    expect(failure.remedy).toContain("CODEX_SANDBOX_MODE");
  });

  it("attributes an unactivated Ark model to the provider and calls it permanent", () => {
    const failure = classifyRunFailure("ModelNotOpen: model is not activated");
    expect(failure.layer).toBe("provider");
    expect(failure.retryability).toBe("permanent");
    expect(blamesAgent(failure)).toBe(false);
  });

  it("treats a rate limit as transient", () => {
    const failure = classifyRunFailure("429 Too Many Requests");
    expect(failure.kind).toBe("rate-limited");
    expect(failure.retryability).toBe("transient");
  });

  it("attributes a broken command the agent wrote to the agent", () => {
    const failure = classifyRunFailure(
      "sh: 1: tsc: command not found",
      { exitCode: 127 },
    );
    expect(failure.layer).toBe("agent");
    expect(blamesAgent(failure)).toBe(true);
    expect(failure.exitCode).toBe(127);
  });

  it("attributes a missing container image to the platform", () => {
    const failure = classifyRunFailure(
      "Error: no such image: launchpad-runtime:latest",
    );
    expect(failure.layer).toBe("platform");
    expect(failure.kind).toBe("container-unavailable");
  });

  // What the runner observed itself is more reliable than anything in the text,
  // so the hints have to win outright.
  it("prefers runner state over pattern matching", () => {
    const timedOut = classifyRunFailure("SandboxDenied { }", {
      timedOut: true,
      timeoutMs: 900_000,
    });
    expect(timedOut.kind).toBe("runtime-timeout");
    expect(timedOut.title).toContain("900000 ms");

    const capped = classifyRunFailure("npm ERR! code E404", {
      outputExceeded: true,
      maxOutputBytes: 1_024,
    });
    expect(capped.kind).toBe("output-cap");
    expect(capped.remedy).toContain("incomplete");

    const stopped = classifyRunFailure("Run cancelled", { cancelled: true });
    expect(stopped.layer).toBe("user");
    expect(stopped.retryability).toBe("user-action");
  });

  it("has a working pattern for every rule", () => {
    const cases: [string, string][] = [
      ["exec_command failed: SandboxDenied { }", "sandbox-denied"],
      ["Tool call denied by the approval policy", "approval-denied"],
      ["ModelNotOpen", "model-unavailable"],
      ["429 Too Many Requests", "rate-limited"],
      ["maximum context length exceeded", "context-length-exceeded"],
      ["401 unauthorized", "auth-rejected"],
      ["connect ECONNREFUSED 127.0.0.1:443", "provider-unreachable"],
      ["TypeError: fetch failed", "provider-unreachable"],
      ["spawn docker ENOENT", "container-unavailable"],
    ];
    for (const [raw, kind] of cases) {
      expect(classifyRunFailure(raw).kind, raw).toBe(kind);
    }
    // The agent-layer rule needs evidence that a command actually ran.
    for (const raw of [
      "Traceback (most recent call last):",
      "npm ERR! code E404",
    ]) {
      expect(
        classifyRunFailure(raw, { source: "tool-step" }).kind,
        raw,
      ).toBe("tool-failed");
    }
  });

  // The agent layer is the only one that says "change the agent", so it must
  // not be reachable from text that merely happens to contain the right words.
  // A provider error body quoting a SyntaxError is not the agent's doing.
  it("refuses to blame the agent for words in someone else's error", () => {
    const body =
      'Ark returned 500: {"error":{"message":"SyntaxError: Unexpected token"}}';
    const unsourced = classifyRunFailure(body);
    expect(unsourced.layer).not.toBe("agent");
    expect(blamesAgent(unsourced)).toBe(false);

    expect(classifyRunFailure(body, { source: "unknown" }).layer).not.toBe(
      "agent",
    );

    // The same text, when it is a command's own output, is the agent's doing.
    expect(classifyRunFailure(body, { source: "tool-step" }).layer).toBe(
      "agent",
    );
    // A non-zero process exit is the same evidence under another name.
    expect(classifyRunFailure(body, { exitCode: 1 }).layer).toBe("agent");
    expect(classifyRunFailure(body, { exitCode: 0 }).layer).not.toBe("agent");
  });

  it("falls back to an unknown platform failure rather than blaming the agent", () => {
    const failure = classifyRunFailure("something nobody has a rule for yet");
    expect(failure.kind).toBe("unknown");
    expect(blamesAgent(failure)).toBe(false);
  });

  // A run that exits 0 with nothing to show is a failed task, not a broken
  // platform — the one case where "the agent is at fault" is the right read.
  it("treats an empty reply as a task failure", () => {
    const failure = noAgentMessageFailure();
    expect(failure.layer).toBe("task");
    expect(blamesAgent(failure)).toBe(true);
    expect(failure.exitCode).toBe(0);
  });
});

// detail used to be whatever text the classifier was handed. For a tool step
// that is the whole failure envelope: kilobytes of Rust Debug syntax, already
// stored on the span it came from, and previously cut mid-escape by an upstream
// clip. The full text stays on the span; this is the line worth quoting.
describe("failure detail", () => {
  const ENVELOPE =
    'exec_command failed: CreateProcess { message: "Codex(Sandbox(Denied { ' +
    "output: ExecToolCallOutput { exit_code: 1, stdout: StreamOutput { text: " +
    '\\"\\" }, stderr: StreamOutput { text: \\"node:events:497\\\\n      ' +
    "throw er;\\\\n\\\\nError: listen EPERM: operation not permitted " +
    '0.0.0.0:8080\\\\n    at Server.listen (node:net:2103:7)\\\\n\\" } } }))" }';

  it("reduces an envelope to the line a person would quote", () => {
    const failure = classifyRunFailure(ENVELOPE, { source: "tool-step" });
    expect(failure.detail).toBe(
      "Error: listen EPERM: operation not permitted 0.0.0.0:8080",
    );
    expect(failure.detail.length).toBeLessThan(ENVELOPE.length / 4);
  });

  it("cuts a single-line envelope at the payload rather than mid-struct", () => {
    const denial =
      'exec_command failed: CreateProcess { message: "Codex(Sandbox(Denied { ' +
      "output: ExecToolCallOutput { exit_code: 1, stdout: StreamOutput { text: " +
      '\\"\\" }, stderr: StreamOutput { text: \\"/bin/bash: line 1: ' +
      '/etc/probe.txt: Permission denied\\\\n\\" } } }))" }';
    expect(classifyRunFailure(denial, { source: "tool-step" }).detail).toBe(
      "/bin/bash: line 1: /etc/probe.txt: Permission denied",
    );
  });

  it("picks the failing line out of Codex's exec summary block", () => {
    const output =
      "Chunk ID: aebf5d\nWall time: 0.05 seconds\nProcess exited with code 127\n" +
      "Original token count: 13\nOutput:\n/bin/bash: line 1: frobnicate: command not found\n";
    expect(classifyRunFailure(output, { source: "tool-step" }).detail).toBe(
      "/bin/bash: line 1: frobnicate: command not found",
    );
  });

  it("leaves a short single-line message alone", () => {
    const failure = classifyRunFailure("", {
      timedOut: true,
      timeoutMs: 900_000,
    });
    expect(failure.detail).toBe("");
    expect(
      classifyRunFailure("connect ECONNREFUSED 127.0.0.1:443").detail,
    ).toBe("connect ECONNREFUSED 127.0.0.1:443");
  });
});

describe("isPermanentProviderError", () => {
  it("separates an unavailable model from an outage", () => {
    expect(isPermanentProviderError(404, null)).toBe(true);
    expect(isPermanentProviderError(400, "ModelNotOpen")).toBe(true);
    expect(isPermanentProviderError(429, "RateLimit")).toBe(false);
    expect(isPermanentProviderError(500, null)).toBe(false);
  });
});

// Both strings are captured verbatim from live Claude Code runs. Before these
// rules existed the same class of failure attributed differently per runtime:
// a Codex credential failure was provider/auth-rejected with an actionable
// remedy, while the Claude Code one fell through to platform/unknown — and
// "platform" points the reader at the launchpad for something only the
// operator's credential can fix.
describe("runtime-neutral provider failures", () => {
  it("attributes a Claude Code auth failure to the provider, not the platform", () => {
    const failure = classifyRunFailure(
      "assistant error: authentication_failed · Not logged in · Please run /login",
      { exitCode: 1, source: "process-exit" },
    );
    expect(failure.layer).toBe("provider");
    expect(failure.kind).toBe("auth-rejected");
    expect(failure.retryability).toBe("user-action");
    // The remedy has to name the credential this runtime actually uses.
    expect(failure.remedy).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(failure.remedy).not.toContain("ARK_API_KEY");
  });

  it("attributes a billing refusal to the provider", () => {
    const failure = classifyRunFailure(
      "assistant error: billing_error · Credit balance is too low · api_error_status=400",
      { exitCode: 1, source: "process-exit" },
    );
    expect(failure.layer).toBe("provider");
    expect(failure.kind).toBe("billing-rejected");
    expect(failure.retryability).toBe("user-action");
  });

  // Verbatim stderr from the CLI, which exits 1 before running anything when
  // it is asked to bypass its permission prompts as uid 0. Without a rule the
  // whole run reports "unknown": a container that dies instantly, with the
  // one line explaining why left unattributed.
  it("attributes the runtime's root refusal to the platform", () => {
    const failure = classifyRunFailure(
      "stderr: --dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
      { exitCode: 1, source: "process-exit" },
    );
    expect(failure.layer).toBe("platform");
    expect(failure.kind).toBe("container-misconfigured");
    expect(failure.remedy).toContain("CONTAINER_USER");
  });

  // The new rules sit ahead of the Ark one and overlap it on status codes, so
  // Ark's own wording has to survive.
  it("still gives an Ark credential failure Ark's remedy", () => {
    const failure = classifyRunFailure(
      "unexpected status 401 Unauthorized: The API key format is incorrect",
      { exitCode: 1, source: "process-exit" },
    );
    expect(failure.kind).toBe("auth-rejected");
    expect(failure.title).toBe("Ark rejected the credentials");
    expect(failure.remedy).toContain("ARK_API_KEY");
  });
});
