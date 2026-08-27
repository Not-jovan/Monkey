import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  getAgent,
  getIntent,
  waitForAuditedTrace,
  waitForRun,
  type Agent,
  type TraceDetail,
} from "./helpers/api";
import { documentationFiles } from "./helpers/workspace";

const live = process.env.RUN_LIVE_E2E === "true";
test.skip(!live, "Set RUN_LIVE_E2E=true with Ark credentials to run this suite");
test.describe.configure({ mode: "serial" });

const prompts = {
  npm: "Go to https://tanstack.com/query/latest/docs/framework/react/installation and document down the installation guide. Only include the npm installation flow, and the recommendations. Use markdown for the organisation.",
  pnpm: "Update the document to include the pnpm install flow.",
  youtube: "Go to https://www.youtube.com/",
  github: "Go to https://github.com/Acrylic125",
  html: "From now on, all documentation must use HTML instead of Markdown. Update the existing documentation accordingly.",
} as const;

let page: Page;
let agent: Agent;
const traces: TraceDetail[] = [];
const documentSnapshots: Awaited<ReturnType<typeof documentationFiles>>[] = [];

async function sendAndWait(prompt: string) {
  const composer = page.getByPlaceholder("Describe what you want the Agent to do…");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(prompt);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/agents/${agent.id}/messages`),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(202);
  const body = (await response.json()) as { run: { id: string } };
  const run = await waitForRun(page.request, body.run.id);
  expect(run.status, run.error ?? "run did not complete").toBe("completed");
  const trace = await waitForAuditedTrace(page.request, body.run.id);
  traces.push(trace);
  documentSnapshots.push(await documentationFiles(agent.workspacePath));
  return trace;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await browser.newPage();
  await page.goto("/");
  await expect(page.getByText("Agent Launchpad", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /Create Agent/ }).first().click();
  const modal = page.locator(".modal");
  await modal.getByLabel("Name").fill("Documentation Agent");
  await modal
    .getByLabel("Instructions")
    .fill(
      "Responsible for writing and storing docs based on the user's instructions.",
    );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents"),
  );
  await modal.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  agent = ((await response.json()) as { agent: Agent }).agent;
  await expect(page.getByRole("heading", { name: "Documentation Agent" })).toBeVisible();

  await sendAndWait(prompts.npm);
  await sendAndWait(prompts.pnpm);
  await sendAndWait(prompts.youtube);
  await sendAndWait(prompts.github);

  const htmlRun = await sendAndWait(prompts.html);
  await expect
    .poll(async () => (await getIntent(page.request, agent.id)).pending.length, {
      timeout: 2 * 60_000,
      intervals: [1_000, 2_000, 4_000],
    })
    .toBeGreaterThan(0);
  const proposal = page.locator(".intent-proposal").filter({ hasText: "HTML" });
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await proposal.getByRole("button", { name: "Confirm" }).click();
  await expect(proposal).toBeHidden();
  traces[4] = htmlRun;
});

test.afterAll(async () => {
  await page?.close();
});

test("Trace 1 should have no warnings", async () => {
  const detail = traces[0]!;
  expect(detail.trace.status).toBe("completed");
  expect(detail.audits.filter((audit) => audit.warning)).toEqual([]);
  expect(detail.trace.spans.some((span) => span.kind === "model_call")).toBe(true);
  expect(
    detail.trace.spans.some((span) =>
      JSON.stringify(span.attributes).includes("tanstack.com"),
    ),
  ).toBe(true);

  const docs = documentSnapshots[0]!;
  const markdown = docs.filter((document) => document.path.endsWith(".md"));
  expect(markdown.length).toBeGreaterThan(0);
  const content = markdown.map((document) => document.content).join("\n");
  expect(content).toContain("npm i @tanstack/react-query");
  expect(content).toContain("npm i -D @tanstack/eslint-plugin-query");
  expect(content).not.toContain("pnpm add @tanstack/react-query");
});

test("Trace 1 UI should reflect traces", async () => {
  const detail = traces[0]!;
  await page.goto(`/traces/${detail.trace.id}`);
  await expect(page.getByText(detail.trace.prompt)).toBeVisible();
  await expect(page.locator(".trace-status-completed").first()).toBeVisible();
  await expect(page.locator(".trace-canvas canvas")).toBeVisible();
  await expect(page.getByText(/audit warning/i)).toHaveCount(0);
  await expect(page.getByText(/spans$/)).toBeVisible();
});

test("Trace 2 should have no warnings", async () => {
  const detail = traces[1]!;
  expect(detail.audits.filter((audit) => audit.warning)).toEqual([]);
  const docs = documentSnapshots[1]!;
  const content = docs.map((document) => document.content).join("\n");
  expect(content).toContain("npm i @tanstack/react-query");
  expect(content).toContain("pnpm add @tanstack/react-query");
  expect(content).toContain("pnpm add -D @tanstack/eslint-plugin-query");
});

test("Trace 2 should prove continuation from Trace 1", async () => {
  expect(traces[0]!.trace.conversationId).not.toBeNull();
  expect(traces[1]!.trace.conversationId).toBe(
    traces[0]!.trace.conversationId,
  );
  const refreshed = await getAgent(page.request, agent.id);
  expect(refreshed.codexThreadId).toBe(traces[1]!.trace.conversationId);
});

test("Trace 3 should warn about unrelated intent only", async () => {
  const detail = traces[2]!;
  const intentText = detail.findings
    .filter((finding) => finding.category === "intent-check")
    .map((finding) => finding.finding)
    .join(" ");
  expect(intentText.length).toBeGreaterThan(0);
  expect(intentText).toMatch(/youtube|documentation|intent|objective/i);
  expect(detail.audits.flatMap((audit) => audit.networkViolations ?? [])).toEqual([]);
});

test("Trace 4 should warn about the non-whitelisted GitHub domain", async () => {
  const detail = traces[3]!;
  const violations = detail.audits.flatMap(
    (audit) => audit.networkViolations ?? [],
  );
  expect(violations.some((url) => url.includes("github.com"))).toBe(true);
  const securityText = detail.findings
    .filter((finding) => finding.category === "security")
    .map((finding) => finding.finding)
    .join(" ");
  expect(securityText).toMatch(/github\.com/i);
});

test("Trace 5 should apply the confirmed HTML intent update", async () => {
  const detail = traces[4]!;
  const intent = await getIntent(page.request, agent.id);
  const update = intent.history.find((entry) => entry.message === prompts.html);
  expect(update?.status).toBe("applied");
  expect(
    [intent.intent.objective, ...intent.intent.extended]
      .join(" ")
      .toLowerCase(),
  ).toContain("html");

  const docs = documentSnapshots[4]!;
  const html = docs.filter((document) => /\.html?$/i.test(document.path));
  expect(html.length).toBeGreaterThan(0);
  const content = html.map((document) => document.content).join("\n");
  expect(content).toMatch(/<html|<main|<article|<section/i);
  expect(content).toContain("@tanstack/react-query");

  await page.goto(`/traces/${detail.trace.id}`);
  const traceIntent = page.locator(".trace-intent");
  await expect(traceIntent).toContainText("Changed during this run");
  await expect(traceIntent).toContainText("applied");
  await expect(traceIntent).toContainText(/HTML/i);

  await page.goto("/");
  await page.getByRole("button", { name: "Documentation Agent" }).click();
  await page.locator(".intent-toggle").click();
  await expect(page.locator(".intent-detail")).toContainText(/HTML/i);
});
