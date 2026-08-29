import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildContainerRunArgs, containerName } from "./container-runtime-runner.js";
import { claudeCodeRuntime } from "./runtimes/claude-code.js";
import { codexRuntime } from "./runtimes/codex.js";

describe("Container runtime runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation for Codex", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
      codexRuntime,
      "collector-token",
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("codex");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    // CODEX_HOME passes through path.resolve, so the mount source is
    // platform-shaped (drive-letter prefixed on Windows).
    expect(args).toContain(
      "type=bind,src=" + path.resolve("/tmp/codex-home") + ",dst=/runtime-home",
    );
    expect(args).toContain("CODEX_HOME=/runtime-home");
    expect(args).toContain("ARK_API_KEY");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
      codexRuntime,
      "collector-token",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

  it("builds an isolated invocation for Claude Code without leaking the host home path", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "secret-that-must-not-appear-in-argv",
      CLAUDE_CODE_HOME: "/tmp/claude-home",
      AGENT_RUNTIME: "claude-code",
      RUNTIME_PROVIDER: "container",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
      claudeCodeRuntime,
      "collector-token",
    );

    expect(args).toContain("claude");
    expect(args).toContain(
      "type=bind,src=" + path.resolve("/tmp/claude-home") + ",dst=/runtime-home",
    );
    expect(args).toContain("CLAUDE_CONFIG_DIR=/runtime-home");
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args).toContain("-p");
    expect(args).toContain("stream-json");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });
});
