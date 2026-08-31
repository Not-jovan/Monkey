import { describe, expect, it } from "vitest";
import type { AuditTraceStep } from "../audit/audit-model.js";
import type { ContextView } from "../context/context-service.js";
import {
  agentDiagnosis,
  agentFailureGroups,
  agentTraceCase,
  agentTraceSummary,
  filterAgentSummaries,
} from "./ai-view.js";
import { emptyUsage, type TraceRecord, type TraceSpan } from "./trace-model.js";

const sandboxDenied = {
  layer: "policy" as const,
  kind: "sandbox-denied",
  retryability: "user-action" as const,
  title: "The Runtime sandbox denied this operation",
  detail: "listen EPERM",
  remedy: "Keep the work inside /workspace.",
  exitCode: 1,
};

const toolFailed = {
  layer: "agent" as const,
  kind: "tool-failed",
  retryability: "transient" as const,
  title: "A command the agent wrote failed",
  detail: "npm ERR! missing script",
  remedy: "Read the failing step, then correct the instructions.",
  exitCode: 1,
};

function span(overrides: Partial<TraceSpan> & { id: string }): TraceSpan {
  return {
    traceId: "trace-1",
    parentId: null,
    name: "tool.shell",
    label: "Tool · shell",
    kind: "tool_call",
    actor: "agent",
    status: "ok",
    startedAt: "2026-08-27T00:00:00.000Z",
    endedAt: "2026-08-27T00:00:01.000Z",
    durationMs: 1_000,
    attributes: {},
    error: null,
    ...overrides,
  };
}

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    version: 1,
    id: "trace-1",
    agentId: "agent-1",
    conversationId: null,
    status: "completed",
    startedAt: "2026-08-27T00:00:00.000Z",
    endedAt: "2026-08-27T00:00:02.000Z",
    prompt: "count files",
    model: "ep-fake",
    usage: emptyUsage(),
    failingSpanId: null,
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    auditOf: null,
    auditDepth: 0,
    spans: [],
    ...overrides,
  };
}

describe("agentDiagnosis", () => {
  it("is null for a clean completed run", () => {
    expect(agentDiagnosis(trace())).toBeNull();
  });

  it("blames the environment for a sandbox denial and points at the failing step", () => {
    const diagnosis = agentDiagnosis(
      trace({
        status: "failed",
        failingSpanId: "shell-1",
        failure: sandboxDenied,
        spans: [
          span({
            id: "plan",
            kind: "model_call",
            name: "model",
            label: "Model · plan",
          }),
          span({
            id: "shell-1",
            status: "error",
            label: "Tool · python -m http.server",
            attributes: {
              output: "SandboxDenied: listen EPERM",
              causedBySpanId: "plan",
            },
            error: "SandboxDenied",
          }),
        ],
      }),
    );
    expect(diagnosis?.outcome).toBe("failed");
    expect(diagnosis?.blame).toBe("environment");
    expect(diagnosis?.layer).toBe("policy");
    expect(diagnosis?.kind).toBe("sandbox-denied");
    expect(diagnosis?.where?.label).toBe("Tool · python -m http.server");
    expect(diagnosis?.causedBy?.spanId).toBe("plan");
    expect(diagnosis?.evidence).toContain("SandboxDenied");
  });

  it("still diagnoses a run that recovered from a classified failure", () => {
    const diagnosis = agentDiagnosis(
      trace({
        status: "completed",
        failure: sandboxDenied,
        recoveredErrorCount: 1,
      }),
    );
    expect(diagnosis?.outcome).toBe("recovered");
    expect(diagnosis?.kind).toBe("sandbox-denied");
  });
});

describe("agentTraceSummary", () => {
  it("clips the prompt and omits evidence from the index row", () => {
    const row = agentTraceSummary({
      trace: trace({
        prompt: "A".repeat(400),
        status: "failed",
        failure: toolFailed,
      }),
      warningCount: 2,
      suspicionCount: 1,
      auditHealth: "ok",
    });
    expect(row.prompt.length).toBeLessThan(400);
    expect(row.prompt.endsWith("…")).toBe(true);
    expect(row.diagnosis?.headline).toBe(toolFailed.title);
    expect(row.diagnosis).not.toHaveProperty("evidence");
    expect(row.warningCount).toBe(2);
    expect(row.suspicionCount).toBe(1);
  });
});

describe("agentFailureGroups", () => {
  it("groups by kind, ranks agent blame first, and skips auditor traces", () => {
    const groups = agentFailureGroups([
      trace({
        id: "auditor-1",
        auditOf: "trace-1",
        failure: toolFailed,
        startedAt: "2026-08-27T00:02:00.000Z",
      }),
      trace({
        id: "policy-1",
        failure: sandboxDenied,
        startedAt: "2026-08-27T00:01:00.000Z",
      }),
      trace({
        id: "agent-1",
        failure: toolFailed,
        startedAt: "2026-08-27T00:00:00.000Z",
      }),
      trace({
        id: "agent-2",
        failure: toolFailed,
        startedAt: "2026-08-26T00:00:00.000Z",
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe("tool-failed");
    expect(groups[0]?.blamesAgent).toBe(true);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.detail).toBe(toolFailed.detail);
    expect(groups[0]?.traceIds).not.toContain("auditor-1");
    expect(groups[1]?.kind).toBe("sandbox-denied");
    expect(groups[1]?.blamesAgent).toBe(false);
  });
});

describe("agentTraceCase", () => {
  const finding = (spanId: string | null): AuditTraceStep => ({
    id: "finding-1",
    traceId: "trace-1",
    agentId: "agent-1",
    spanId,
    intentId: "intent-1",
    type: "warning",
    category: "intent-check",
    finding: "Wrote outside the workspace.",
  });

  const emptyContext: ContextView = {
    carriedIn: {
      version: 1,
      traceId: "earlier",
      agentId: "agent-1",
      conversationId: "thread-1",
      startedAt: "2026-08-27T00:00:00.000Z",
      endedAt: "2026-08-27T00:00:01.000Z",
      summary: "Asked to: document the install. Outcome: completed",
      source: "derived",
      digest: {
        prompt: "document the install",
        outcome: "completed",
        filesTouched: [],
        commands: [],
        services: [],
        failureKind: null,
        failureLayer: null,
      },
    },
    carriedOut: null,
    position: 2,
    chainLength: 2,
    previousTraceId: "earlier",
    nextTraceId: null,
  };

  it("returns a case file without the span dump", () => {
    const record = trace({
      status: "failed",
      failingSpanId: "shell-1",
      failure: toolFailed,
      prompt: "fix the tests",
      spans: [
        span({ id: "run", kind: "run", name: "agent.run", label: "Run" }),
        span({
          id: "plan",
          kind: "model_call",
          name: "model",
          label: "Model · plan",
          attributes: { output: "I'll run npm test." },
        }),
        span({
          id: "shell-1",
          status: "error",
          label: "Tool · npm test",
          attributes: {
            arguments: JSON.stringify({ command: "npm test" }),
            output: "npm ERR! missing script: test",
            causedBySpanId: "plan",
          },
          error: "npm ERR! missing script: test",
        }),
      ],
    });

    const payload = agentTraceCase({
      trace: record,
      findings: [finding("shell-1")],
      auditComplete: true,
      auditHealth: "ok",
      intent: {
        instructions: "Build a todo list.",
        objective: "Build a todo list.",
        extended: ["Do not read .env files."],
      },
      context: emptyContext,
      auditTraceId: "auditor-1",
      auditAttempts: [
        {
          id: "auditor-1",
          status: "completed",
          startedAt: "2026-08-28T00:00:01.000Z",
          endedAt: "2026-08-28T00:00:02.000Z",
        },
      ],
      auditChain: [{ id: "trace-1", auditDepth: 0, status: "failed" }],
    });

    expect(payload).not.toHaveProperty("trace");
    expect(payload).not.toHaveProperty("spans");
    expect(payload.diagnosis?.blame).toBe("agent");
    expect(payload.failingStep?.commands).toEqual(["npm test"]);
    expect(payload.causedByStep?.label).toBe("Model · plan");
    expect(payload.trajectory.some((line) => line.includes("Tool · npm test"))).toBe(
      true,
    );
    expect(payload.trajectory.some((line) => line.includes("Run"))).toBe(false);
    expect(payload.findings[0]?.span?.label).toBe("Tool · npm test");
    expect(payload.context?.carriedIn).toContain("document the install");
    expect(payload.context).not.toHaveProperty("carriedOut");
    expect(payload.intent?.extended).toEqual(["Do not read .env files."]);
  });
});

describe("filterAgentSummaries", () => {
  it("keeps only agent-blame rows when asked", () => {
    const rows = [
      agentTraceSummary({
        trace: trace({ id: "a", status: "failed", failure: toolFailed }),
        warningCount: 0,
        suspicionCount: 0,
        auditHealth: "ok",
      }),
      agentTraceSummary({
        trace: trace({ id: "b", status: "failed", failure: sandboxDenied }),
        warningCount: 0,
        suspicionCount: 0,
        auditHealth: "ok",
      }),
      agentTraceSummary({
        trace: trace({ id: "c", status: "completed" }),
        warningCount: 0,
        suspicionCount: 0,
        auditHealth: "ok",
      }),
    ];
    const filtered = filterAgentSummaries(rows, { blame: "agent" });
    expect(filtered.map((row) => row.id)).toEqual(["a"]);
  });
});
