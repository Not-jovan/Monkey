import { defineConfig, devices } from "@playwright/test";

const live = process.env.RUN_LIVE_E2E === "true";
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;
const stateRoot = `/tmp/monkey-playwright-${process.pid}`;

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
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: live
    ? {
        command: "npm run poc",
        url: `${baseURL}/api/health`,
        timeout: 4 * 60_000,
        reuseExistingServer: false,
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          PUBLIC_PORT: String(port),
          LOCAL_POC_DATA_ROOT: stateRoot,
          AUDIT_ENABLED: "true",
          AUDIT_NETWORK_WHITELIST:
            "tanstack.com,youtube.com,.youtube.com",
        },
      }
    : undefined,
});
