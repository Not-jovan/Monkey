import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  waitForAuditedTrace,
  waitForRun,
  waitForTrace,
  type Agent,
} from "./helpers/api";

const live = process.env.RUN_LIVE_E2E === "true";
const execFileAsync = promisify(execFile);
test.skip(!live, "Set RUN_LIVE_E2E=true with Ark credentials to run this suite");
test.describe.configure({ mode: "serial" });

async function activeRuntimeContainer(
  request: import("@playwright/test").APIRequestContext,
  agentId: string,
): Promise<{ engine: string; containerId: string }> {
  const systemResponse = await request.get("/api/system");
  expect(systemResponse.ok(), await systemResponse.text()).toBe(true);
  const system = (await systemResponse.json()) as {
    containerEngine: string | null;
  };
  expect(system.containerEngine).toBeTruthy();
  const engine = system.containerEngine!;

  let containerId = "";
  await expect
    .poll(
      async () => {
        const result = await execFileAsync(engine, [
          "ps",
          "--quiet",
          "--filter",
          "label=io.codejam.agent-id=" + agentId,
        ]);
        containerId = result.stdout.trim().split(/\s+/)[0] ?? "";
        return containerId;
      },
      { timeout: 30_000, intervals: [100, 250, 500] },
    )
    .not.toBe("");
  return { engine, containerId };
}

test.beforeAll(async ({ request }) => {
  const systemResponse = await request.get("/api/system");
  expect(systemResponse.ok(), await systemResponse.text()).toBe(true);
  const system = (await systemResponse.json()) as { agentRuntime: string };
  expect(system.agentRuntime).toBe("codex");
});

test("a normal Codex run produces a well-formed, redacted span tree", async ({
  request,
}) => {
  const createResponse = await request.post("/api/agents", {
    data: {
      name: "Codex Tracing E2E Agent",
      instructions:
        "Follow the user's instructions exactly and keep responses brief.",
    },
  });
  expect(createResponse.status(), await createResponse.text()).toBe(201);
  const agent = ((await createResponse.json()) as { agent: Agent }).agent;

  const messageResponse = await request.post(
    `/api/agents/${agent.id}/messages`,
    {
      data: {
        content:
          "List the files currently in your workspace, then create a file named trace-check.md containing a one-sentence summary of what you did.",
      },
    },
  );
  expect(messageResponse.status(), await messageResponse.text()).toBe(202);
  const { run } = (await messageResponse.json()) as { run: { id: string } };

  const finishedRun = await waitForRun(request, run.id);
  expect(finishedRun.status, finishedRun.error ?? "run did not complete").toBe(
    "completed",
  );

  const detail = await waitForAuditedTrace(request, run.id);
  const { trace } = detail;

  // Span-tree shape: every kind the pipeline is meant to produce is present.
  expect(trace.status).toBe("completed");
  expect(trace.conversationId).toBeTruthy();
  for (const kind of [
    "run",
    "user_action",
    "turn",
    "model_call",
    "tool_call",
  ] as const) {
    expect(
      trace.spans.some((span) => span.kind === kind),
      `expected at least one "${kind}" span`,
    ).toBe(true);
  }

  // Parent/child integrity: exactly one root, every parentId resolves within the trace.
  const spanIds = new Set(trace.spans.map((span) => span.id));
  const roots = trace.spans.filter((span) => span.parentId === null);
  expect(roots.length).toBe(1);
  expect(roots[0]?.kind).toBe("run");
  for (const span of trace.spans) {
    if (span.parentId !== null) {
      expect(spanIds.has(span.parentId)).toBe(true);
    }
  }

  // Usage and evidence accounting.
  expect(trace.usage.inputTokens).toBeGreaterThan(0);
  expect(trace.usage.outputTokens).toBeGreaterThan(0);
  expect(trace.evidenceComplete).toBe(true);

  // Secret redaction: the Ark API key must never appear in a persisted trace.
  const arkApiKey = process.env.ARK_API_KEY;
  if (arkApiKey) {
    expect(JSON.stringify(trace)).not.toContain(arkApiKey);
  }

  // Audit results are well-formed for a clean run.
  expect(detail.auditComplete).toBe(true);
  expect(detail.auditHealth).toBe("ok");
  expect(detail.auditTraceId).toBeTruthy();
  for (const finding of detail.findings) {
    expect(finding.traceId).toBe(trace.id);
    expect(["warning", "suspicion", "error"]).toContain(finding.type);
    expect([
      "intent-check",
      "security",
      "reliability",
      "audit-health",
    ]).toContain(finding.category);
    expect(finding.finding.length).toBeGreaterThan(0);
  }

  const auditResponse = await request.get(`/api/audits/${trace.id}`);
  expect(auditResponse.ok(), await auditResponse.text()).toBe(true);
  const audit = (await auditResponse.json()) as {
    auditedTraceId: string;
    health: string;
    auditTraceId: string | null;
    auditor: { id: string } | null;
  };
  expect(audit.auditedTraceId).toBe(trace.id);
  expect(audit.health).toBe(detail.auditHealth);
  expect(audit.auditTraceId).toBe(detail.auditTraceId);
  expect(audit.auditor?.id).toBe(detail.auditTraceId);

  // Confirm the auditor's own trace is retrievable and correctly chained.
  // Nothing auto-audits a depth-1 (auditor) trace, so wait for it to reach a
  // terminal status only — not for it to itself be audited (that on-demand
  // re-audit path is covered by documentation-agent.spec.ts).
  const auditorTraceId = detail.auditTraceId!;
  const auditorDetail = await waitForTrace(request, auditorTraceId);
  expect(auditorDetail.trace.auditOf).toBe(trace.id);
  expect(auditorDetail.trace.auditDepth).toBe(1);
});

test("a killed runtime produces a fully attributed failure trace", async ({
  request,
}) => {
  const createResponse = await request.post("/api/agents", {
    data: {
      name: "Codex Tracing Failure E2E Agent",
      instructions: "Follow the user's instructions exactly.",
    },
  });
  expect(createResponse.status(), await createResponse.text()).toBe(201);
  const agent = ((await createResponse.json()) as { agent: Agent }).agent;

  const messageResponse = await request.post(
    `/api/agents/${agent.id}/messages`,
    {
      data: {
        content:
          "Work on a long-running task and do not finish before 2 minutes have passed.",
      },
    },
  );
  expect(messageResponse.status(), await messageResponse.text()).toBe(202);
  const { run } = (await messageResponse.json()) as { run: { id: string } };

  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/runs/${run.id}`);
        if (!response.ok()) return "http-" + response.status();
        return ((await response.json()) as { run: { status: string } }).run
          .status;
      },
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    )
    .toBe("running");

  const { engine, containerId } = await activeRuntimeContainer(
    request,
    agent.id,
  );
  await execFileAsync(engine, ["rm", "--force", containerId]);

  const failedRun = await waitForRun(request, run.id);
  expect(failedRun.status).toBe("failed");
  expect(failedRun.error).toBeTruthy();

  const failedDetail = await waitForTrace(request, run.id);
  expect(failedDetail.trace.status).toBe("failed");
  expect(failedDetail.trace.failure).not.toBeNull();
  expect(failedDetail.trace.failure?.layer).toBeTruthy();
  expect(failedDetail.trace.failure?.kind).toBeTruthy();
  expect(["transient", "permanent", "user-action"]).toContain(
    failedDetail.trace.failure?.retryability,
  );
  expect(failedDetail.trace.failure?.title).toBeTruthy();
  expect(failedDetail.trace.failure?.remedy).toBeTruthy();
  expect(failedDetail.trace.failingSpanId).toBeTruthy();
  expect(
    failedDetail.trace.spans.some(
      (span) => span.id === failedDetail.trace.failingSpanId,
    ),
  ).toBe(true);
});
