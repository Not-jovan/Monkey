import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  correctIntent,
  corrections,
  getAgent,
  getIntent,
  waitForAuditedTrace,
  waitForRun,
  type Agent,
  type AuditTraceStep,
  type TraceDetail,
} from "./helpers/api";
import { documentationFiles } from "./helpers/workspace";

const live = process.env.RUN_LIVE_E2E === "true";
test.skip(!live, "Set RUN_LIVE_E2E=true with Ark credentials to run this suite");
test.describe.configure({ mode: "serial" });

const prompts = {
  docs:
    "Create documentation for installing TanStack Query in React. Use the official page at https://tanstack.com/query/latest/docs/framework/react/installation. Include the npm install flow and the recommended ESLint plugin. Use markdown.",
  github:
    "Open https://github.com/Acrylic125 and summarize what you can see in the documentation workspace.",
  html:
    "From now on, all documentation must use HTML instead of Markdown. Update the existing documentation accordingly.",
} as const;

const humanCorrection =
  "For GitHub policy findings, do not browse non-whitelisted GitHub URLs without explicit approval.";

let page: Page;
let agent: Agent;
let docsTrace: TraceDetail;
let githubTrace: TraceDetail;
let htmlTrace: TraceDetail;

async function sendMessage(prompt: string) {
  const composer = page.getByPlaceholder(/Describe what you want the Agent to do/);
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
  return waitForAuditedTrace(page.request, body.run.id);
}

function actionableFindings(detail: TraceDetail) {
  return detail.findings.filter(
    (finding) =>
      finding.type === "warning" &&
      (finding.category === "security" ||
        finding.category === "intent-check" ||
        finding.category === "reliability"),
  );
}

function securityText(findings: AuditTraceStep[]) {
  return findings
    .filter((finding) => finding.category === "security")
    .map((finding) => finding.finding)
    .join(" ");
}

async function currentTraceDetail(traceId: string) {
  const response = await page.request.get(`/api/traces/${traceId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as TraceDetail;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await browser.newPage();
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await expect(page.getByText("Agent Launchpad", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /Create Agent/ }).first().click();
  const modal = page.locator(".modal");
  await modal.getByLabel("Name").fill("Documentation Agent");
  await modal
    .getByLabel("Instructions")
    .fill("Write and update documentation according to the user's instructions.");

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents"),
  );
  await modal.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  agent = ((await response.json()) as { agent: Agent }).agent;
  await expect(
    page.getByRole("heading", { level: 1, name: "Documentation Agent" }),
  ).toBeVisible();

  docsTrace = await sendMessage(prompts.docs);
  githubTrace = await sendMessage(prompts.github);
  htmlTrace = await sendMessage(prompts.html);
});

test.afterAll(async () => {
  await page?.close();
});

test("a normal run records trace evidence, documentation output, and an auditor trace", async () => {
  expect(docsTrace.trace.status).toBe("completed");
  expect(docsTrace.trace.auditOf).toBeNull();
  expect(docsTrace.auditComplete).toBe(true);
  expect(docsTrace.auditTraceId).not.toBeNull();
  expect(docsTrace.trace.spans.some((span) => span.kind === "model_call")).toBe(true);

  const docs = await documentationFiles(agent.workspacePath);
  const content = docs.map((document) => document.content).join("\n");
  expect(content).toMatch(/@tanstack\/react-query/i);
  expect(content).toMatch(/npm|eslint/i);

  await page.goto(`/traces/${docsTrace.trace.id}`);
  await expect(page.getByText(docsTrace.trace.prompt)).toBeVisible();
  await expect(page.locator(".trace-status-completed").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: /View Run/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: /View Auditor/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get Debug Prompt" })).toBeVisible();
});

test("a non-whitelisted GitHub run can start a Debug Agent", async () => {
  const findings = actionableFindings(githubTrace);
  expect(findings.length).toBeGreaterThan(0);
  expect(securityText(githubTrace.findings)).toMatch(/github\.com/i);

  await page.goto(`/traces/${githubTrace.trace.id}`);
  const panel = page.locator(".trace-debug-agent");
  await expect(panel.getByRole("heading", { name: "Debug Agent" })).toBeVisible();

  const createPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/agents") &&
      !response.url().includes("/messages"),
  );
  const messagePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/agents\/[^/]+\/messages$/.test(new URL(response.url()).pathname),
  );
  await panel.getByRole("button", { name: "Start Debug Agent" }).click();
  const created = await createPromise;
  expect(created.status(), await created.text()).toBe(201);
  const debugAgent = ((await created.json()) as { agent: Agent }).agent;
  expect(debugAgent.name).toBe("Debug");
  expect(debugAgent.instructions).toContain(
    `/api/traces/${githubTrace.trace.id}/ai`,
  );
  const message = await messagePromise;
  expect(message.status(), await message.text()).toBe(202);

  await expect(page).toHaveURL(new RegExp("[?&]agent=" + debugAgent.id));
  await expect(
    page.getByRole("heading", { level: 1, name: "Debug" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Deduce the issue and give me the constraint set to minimise these issues",
    ),
  ).toBeVisible();
});

test("a correction appears in current constraints but not in other run correction history", async () => {
  const findingIds = actionableFindings(githubTrace)
    .slice(0, 2)
    .map((finding) => finding.id);
  expect(findingIds.length).toBeGreaterThan(0);
  await correctIntent(
    page.request,
    githubTrace.trace.id,
    findingIds,
    humanCorrection,
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Documentation Agent" }).click();
  await page.locator(".intent-toggle").click();
  const intent = page.locator(".intent-detail");
  await expect(intent).toContainText(humanCorrection);
  await expect(intent).toContainText(/Human correction/i);

  await page.goto(`/traces/${docsTrace.trace.id}`);
  await expect(page.getByText(docsTrace.trace.prompt)).toBeVisible();
  // A run with no visible findings or corrections intentionally has no
  // correction panel. Assert against the history entry itself so both valid
  // render states prove that another run's correction did not leak here.
  await expect(
    page.locator(".correction-history").getByText(humanCorrection, {
      exact: true,
    }),
  ).toHaveCount(0);

  const correctedFinding = (await corrections(page.request, agent.id)).find(
    (entry) => entry.traceId === githubTrace.trace.id,
  )?.findingIds[0];
  expect(correctedFinding).toBeTruthy();
  const directDuplicate = await page.request.post(
    `/api/traces/${githubTrace.trace.id}/intent/correct`,
    {
      data: {
        findingIds: [correctedFinding],
        correction: "Duplicate correction should be rejected.",
      },
    },
  );
  expect(directDuplicate.status()).toBe(409);
});

test("an intent update is reflected on the run and in current intent history", async () => {
  const intent = await getIntent(page.request, agent.id);
  expect(
    [intent.intent.objective, ...intent.intent.extended]
      .join(" ")
      .toLowerCase(),
  ).toContain("html");

  const docs = await documentationFiles(agent.workspacePath);
  const html = docs.filter((document) => /\.html?$/i.test(document.path));
  expect(html.length).toBeGreaterThan(0);
  expect(html.map((document) => document.content).join("\n")).toMatch(
    /<html|<main|<article|<section/i,
  );

  await page.goto(`/traces/${htmlTrace.trace.id}`);
  await expect(page.locator(".trace-intent")).toContainText(/HTML/i);

  await page.goto("/");
  await page.getByRole("button", { name: "Documentation Agent" }).click();
  await page.locator(".intent-toggle").click();
  await page.locator(".intent-history-toggle").click();
  await expect(page.locator(".intent-history")).toContainText(/HTML/i);
});

test("the auditor trace can be opened and audited on demand", async () => {
  expect(githubTrace.auditTraceId).not.toBeNull();
  const auditorId = githubTrace.auditTraceId!;

  await page.goto(`/traces/${githubTrace.trace.id}`);
  await page.getByRole("tab", { name: /View Auditor/ }).click();
  await expect(page.getByText(/Audit of trace/i)).toBeVisible();
  await expect(page.locator(".trace-debug-agent")).toHaveCount(0);

  await page.goto(`/traces/${auditorId}?pane=run`);
  await expect(page.getByRole("tab", { name: /View Run/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".audit-chain")).toContainText("Agent run");
  await expect(page.locator(".audit-chain")).toContainText("Audit");

  const beforeAudit = await currentTraceDetail(auditorId);
  if (!beforeAudit.auditComplete) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/traces/${auditorId}/audit`),
    );
    await page.getByRole("button", { name: "Audit", exact: true }).click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(200);
  }

  const auditorDetail = await waitForAuditedTrace(page.request, auditorId);
  expect(auditorDetail.trace.auditOf).toBe(githubTrace.trace.id);
  expect(auditorDetail.trace.auditDepth).toBe(1);
  expect(auditorDetail.auditTraceId).not.toBeNull();
});

test("correction APIs keep source-run evidence scoped", async () => {
  const alreadyCorrected = new Set(
    (await corrections(page.request, agent.id))
      .filter((entry) => entry.traceId === githubTrace.trace.id && entry.revertedAt === null)
      .flatMap((entry) => entry.findingIds),
  );
  const uncorrectedFinding = actionableFindings(githubTrace).find(
    (finding) => !alreadyCorrected.has(finding.id),
  );
  test.skip(
    !uncorrectedFinding,
    "Need another actionable finding for direct API correction",
  );

  const created = await correctIntent(
    page.request,
    githubTrace.trace.id,
    [uncorrectedFinding.id],
    "Treat related GitHub findings as one source-run correction.",
  );

  expect(created.traceId).toBe(githubTrace.trace.id);
  expect(created.findingIds).toEqual([uncorrectedFinding.id]);

  const all = await corrections(page.request, agent.id);
  expect(all.filter((entry) => entry.traceId === docsTrace.trace.id)).toEqual([]);
  expect(all.some((entry) => entry.traceId === githubTrace.trace.id)).toBe(true);

  const auditorId = githubTrace.auditTraceId!;
  const directCorrection = await page.request.post(
    `/api/traces/${auditorId}/intent/correct`,
    {
      data: {
        findingIds: [uncorrectedFinding.id],
        correction: "This should not be accepted from an auditor trace.",
      },
    },
  );
  expect(directCorrection.status()).toBe(409);

  const refreshed = await getAgent(page.request, agent.id);
  expect(refreshed.codexThreadId).toBe(htmlTrace.trace.conversationId);
});
