import { expect, test } from "@playwright/test";
import {
  waitForAuditedTrace,
  waitForRun,
  type Agent,
} from "./helpers/api";
import { documentationFiles } from "./helpers/workspace";

test("credential-free run reaches the real trace and audit UI", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("Agent Launchpad", { exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: /Create Agent/ }).first().click();
  const modal = page.locator(".modal");
  await modal.getByLabel("Name").fill("Offline Evidence Agent");
  await modal
    .getByLabel("Instructions")
    .fill("Create the requested proof artifact and report what you did.");

  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents"),
  );
  await modal.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createResponse;
  expect(created.status(), await created.text()).toBe(201);
  const agent = ((await created.json()) as { agent: Agent }).agent;

  const prompt =
    "Create trace-check.md as deterministic credential-free E2E evidence.";
  const composer = page.getByPlaceholder(/Describe what you want the Agent to do/);
  await composer.fill(prompt);
  const messageResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/agents/${agent.id}/messages`),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const accepted = await messageResponse;
  expect(accepted.status(), await accepted.text()).toBe(202);
  const { run } = (await accepted.json()) as { run: { id: string } };

  const finished = await waitForRun(page.request, run.id);
  expect(finished.status, finished.error ?? "run did not complete").toBe(
    "completed",
  );
  const detail = await waitForAuditedTrace(page.request, run.id);

  expect(detail.trace.status).toBe("completed");
  expect(detail.trace.evidenceComplete).toBe(true);
  expect(detail.trace.conversationId).toBe("offline-e2e-thread");
  expect(detail.trace.spans.some((span) => span.kind === "model_call")).toBe(
    true,
  );
  expect(detail.trace.spans.some((span) => span.kind === "tool_call")).toBe(
    true,
  );
  expect(detail.auditComplete).toBe(true);
  expect(detail.auditHealth).toBe("ok");
  expect(detail.auditTraceId).toBeTruthy();
  expect(JSON.stringify(detail)).not.toContain(
    "offline-e2e-secret-that-must-be-redacted",
  );

  const files = await documentationFiles(agent.workspacePath);
  expect(files.some((file) => file.path.endsWith("trace-check.md"))).toBe(true);

  await page.goto(`/traces/${run.id}`);
  await expect(page.getByText(prompt)).toBeVisible();
  await expect(page.locator(".trace-status-completed").first()).toBeVisible();
  await page.getByRole("tab", { name: /View Auditor/ }).click();
  await expect(page.getByText(`Audit of trace ${run.id}`)).toBeVisible();
  await expect(page.getByText("Audit the target agent.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View auditor's trace details" }),
  ).toBeVisible();
});
