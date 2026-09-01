import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const live = process.env.RUN_LIVE_E2E === "true";
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const stateRoot = `/tmp/monkey-playwright-${process.pid}`;
const fixtureCodex = path.resolve("tests/e2e/fixtures/codex-fixture.mjs");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: live ? "live-chromium" : "offline-chromium",
      testMatch: live ? /.*\.spec\.ts/ : /.*\.offline\.spec\.ts/,
      testIgnore: live ? /.*\.offline\.spec\.ts/ : undefined,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: live
      ? "npm run poc"
      : "node tests/e2e/support/offline-server.mjs",
    url: `${baseURL}/api/health`,
    timeout: live ? 4 * 60_000 : 30_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_PORT: String(port),
      LOCAL_POC_DATA_ROOT: stateRoot,
      APP_DATA_DIR: path.join(stateRoot, "data"),
      AGENT_WORKSPACE_ROOT: path.join(stateRoot, "workspaces"),
      CODEX_HOME: path.join(stateRoot, "codex-home"),
      CODEX_BIN: fixtureCodex,
      E2E_ARK_PORT: String(port + 1),
      AUDIT_ENABLED: "true",
      AUDIT_NETWORK_WHITELIST:
        "tanstack.com,youtube.com,.youtube.com",
    },
  },
});
