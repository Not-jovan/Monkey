import { describe, expect, it } from "vitest";
import { collectorLogsUrl, loadConfig, secretValues } from "./config.js";

describe("codex config generation", () => {
  // The otel-section-generation test moved to runtimes/codex.test.ts
  // alongside codexRuntime.bootstrap, which now owns that logic.

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

  it("uses the chat agent's model for audits unless an audit model is set", () => {
    expect(
      loadConfig({ NODE_ENV: "test", ARK_MODEL: "deepseek-v4-flash-260425" })
        .auditSecurityModel,
    ).toBe("deepseek-v4-flash-260425");
    expect(
      loadConfig({ NODE_ENV: "test", ARK_MODEL: "deepseek-v4-flash-260425" })
        .auditIntentModel,
    ).toBe("deepseek-v4-flash-260425");
    expect(
      loadConfig({
        NODE_ENV: "test",
        ARK_MODEL: "deepseek-v4-flash-260425",
        AUDIT_SECURITY_MODEL: "other-model",
      }).auditSecurityModel,
    ).toBe("other-model");
    expect(loadConfig({ NODE_ENV: "test" }).auditSecurityModel).toBe(
      "deepseek-v4-flash-ga-260731",
    );
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
