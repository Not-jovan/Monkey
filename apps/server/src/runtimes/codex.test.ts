import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { buildCodexArgs, codexRuntime, parseCodexEventLine } from "./codex.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeCodexHome() {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-home-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("codexRuntime.bootstrap", () => {
  it("emits an otel section that keeps telemetry local and secured", async () => {
    const codexHome = await makeCodexHome();
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: codexHome,
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container",
      PORT: "3123",
    });
    await codexRuntime.bootstrap(config, "per-boot-token");
    const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");

    expect(toml).toContain("log_user_prompt = true");
    // Codex 0.111.0 otherwise defaults metrics to its own Statsig endpoint.
    expect(toml).toContain('metrics_exporter = "none"');
    expect(toml).toContain('trace_exporter = "none"');
    expect(toml).toContain(
      'endpoint = "http://host.docker.internal:3123/collector/v1/logs"',
    );
    expect(toml).toContain('protocol = "json"');
    expect(toml).toContain('"x-collector-token" = "per-boot-token"');
    expect(toml).not.toContain("test-key");
  });
});

describe("Codex runtime protocol", () => {
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
      model: null as string | null,
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
    // Codex leaves the model to config and to the OTLP conversation_starts
    // event; the stdout stream never sets it.
    expect(parsed.model).toBeNull();
  });
});
