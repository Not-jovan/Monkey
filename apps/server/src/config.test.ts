import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectorLogsUrl,
  loadConfig,
  secretValues,
  writeCodexConfig,
} from "./config.js";

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

describe("codex config generation", () => {
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
    await writeCodexConfig(config, "per-boot-token");
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

  it("targets the loopback collector for the local-process runtime", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "local-process",
      PORT: "3000",
    });
    expect(collectorLogsUrl(config)).toBe(
      "http://127.0.0.1:3000/collector/v1/logs",
    );
  });

  it("honors an explicit collector URL override", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      OTEL_COLLECTOR_URL: "http://10.0.0.5:9999/",
    });
    expect(collectorLogsUrl(config)).toBe(
      "http://10.0.0.5:9999/collector/v1/logs",
    );
  });

  it("exposes exactly the configured secrets for masking", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "ark-key-value",
      APP_AUTH_TOKEN: "operator-token-value",
    });
    expect(secretValues(config)).toEqual(["ark-key-value", "operator-token-value"]);
    const bare = loadConfig({ NODE_ENV: "test" });
    expect(secretValues(bare)).toEqual([]);
  });
});
