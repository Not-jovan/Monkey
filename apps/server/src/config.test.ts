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

describe("production auth token guard", () => {
  const base = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    ARK_API_KEY: "x",
    ARK_MODEL: "ep-x",
  } as NodeJS.ProcessEnv;

  it("names the placeholder rather than blaming its length", () => {
    // The .env.example placeholder is 37 characters, so a length-only message
    // sends the operator hunting for a problem that is not there.
    expect(() =>
      loadConfig({ ...base, APP_AUTH_TOKEN: "replace-with-at-least-24-random-chars" }),
    ).toThrow(/still the placeholder/);
  });

  it("reports the actual length when the token is too short", () => {
    expect(() => loadConfig({ ...base, APP_AUTH_TOKEN: "tooshort" })).toThrow(
      /at least 24 characters.*got 8/s,
    );
  });

  it("accepts a real token", () => {
    const token = "9f1kfoHQywOlBLOiIdCEKW4P7KkoWl1z";
    expect(loadConfig({ ...base, APP_AUTH_TOKEN: token }).authToken).toBe(token);
  });

  it("leaves loopback servers alone", () => {
    expect(
      loadConfig({ ...base, HOST: "127.0.0.1", APP_AUTH_TOKEN: "" }).authToken,
    ).toBe("");
  });
});
