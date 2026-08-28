import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { claudeCodeRuntime } from "./claude-code.js";
import { codexRuntime } from "./codex.js";
import { selectRuntime } from "./index.js";

// The whole AGENT_RUNTIME feature hinges on this dispatch, and every
// downstream consumer (runner, container argv, trace adapter) is driven by
// whichever definition comes back, so it is worth pinning directly.
describe("selectRuntime", () => {
  const baseEnv = {
    NODE_ENV: "test",
    ARK_API_KEY: "ark-key",
    ARK_MODEL: "ep-test",
  } as const;

  it("defaults to Codex when AGENT_RUNTIME is unset", () => {
    const runtime = selectRuntime(loadConfig({ ...baseEnv }));
    expect(runtime).toBe(codexRuntime);
    expect(runtime.id).toBe("codex");
  });

  it("selects Codex explicitly", () => {
    const runtime = selectRuntime(loadConfig({ ...baseEnv, AGENT_RUNTIME: "codex" }));
    expect(runtime).toBe(codexRuntime);
  });

  it("selects Claude Code, carrying its own binary and home env var", () => {
    const config = loadConfig({
      ...baseEnv,
      AGENT_RUNTIME: "claude-code",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    const runtime = selectRuntime(config);

    expect(runtime).toBe(claudeCodeRuntime);
    expect(runtime.id).toBe("claude-code");
    expect(runtime.bin(config)).toBe("claude");
    // Codex relocates its home with CODEX_HOME; Claude Code uses a
    // differently-named variable, and the runners read it from here.
    expect(runtime.homeEnvVar).toBe("CLAUDE_CONFIG_DIR");
    expect(runtime.trace.correlationAttribute).toBe("session.id");
  });

  it("rejects an unknown AGENT_RUNTIME at config load rather than falling back", () => {
    expect(() => loadConfig({ ...baseEnv, AGENT_RUNTIME: "gemini-cli" })).toThrow();
  });
});
