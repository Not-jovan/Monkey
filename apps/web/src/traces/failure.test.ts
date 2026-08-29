import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/codex-failure.json" with { type: "json" };
import { buildDiagnosis, recoveryNote } from "./failure";
import type { RunFailure, TraceRecord, TraceSpan } from "../types";

const RAW = fixture.output;

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: "span-tool",
    traceId: "trace-1",
    parentId: null,
    name: "tool.exec_command",
    label: "Tool · exec_command",
    kind: "tool_call",
    actor: "agent",
    status: "error",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:00:01.000Z",
    durationMs: 1_000,
    attributes: { toolName: "exec_command" },
    error: null,
    ...overrides,
  };
}

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "trace-1",
    agentId: "agent-1",
    conversationId: "thread-1",
    status: "failed",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: "2026-08-28T00:00:05.000Z",
    prompt: "serve the docs on port 8080",
    model: "ep-1",
    usage: {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      toolTokens: 0,
    },
    failingSpanId: "span-tool",
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    auditOf: null,
    auditDepth: 0,
    spans: [span({ error: RAW })],
    ...overrides,
  };
}

const sandboxDenied: RunFailure = {
  layer: "policy",
  kind: "sandbox-denied",
  retryability: "user-action",
  title: "The Runtime sandbox denied this operation",
  detail: "listen EPERM 0.0.0.0:8080",
  remedy: "Keep the work inside /workspace.",
  exitCode: 1,
};

describe("buildDiagnosis", () => {
  // The distinction the whole feature exists for: a reader must be able to tell
  // "the boundary stopped it" from "the agent broke something", because the two
  // lead to opposite next actions.
  it("says plainly when a failure is not the agent's fault", () => {
    const diagnosis = buildDiagnosis(trace({ failure: sandboxDenied }));
    expect(diagnosis?.blame).toBe("environment");
    expect(diagnosis?.layerLabel).toBe("Policy");
    expect(diagnosis?.attribution).toContain("Not an agent defect");
    expect(diagnosis?.retryability).toBe("Needs a change before retrying");
  });

  it("says plainly when it is", () => {
    const diagnosis = buildDiagnosis(
      trace({
        failure: {
          ...sandboxDenied,
          layer: "agent",
          kind: "tool-failed",
          retryability: "transient",
        },
      }),
    );
    expect(diagnosis?.blame).toBe("agent");
    expect(diagnosis?.attribution).toContain("worth improving");
  });

  it("recovers the structured envelope from the failing step", () => {
    const diagnosis = buildDiagnosis(trace({ failure: sandboxDenied }));
    expect(diagnosis?.raw).toBe(RAW);
    expect(diagnosis?.envelope).not.toBeNull();
    // The raw form is one escaped line; the structure only exists after parsing.
    expect(RAW).not.toContain("\n");
    expect(diagnosis?.envelope?.problems.length).toBeGreaterThan(0);
  });

  // Which model call planned the failing step is the difference between fixing
  // the plan and fixing the execution.
  it("links the failing step back to the model call that planned it", () => {
    const planning = span({
      id: "span-model",
      kind: "model_call",
      name: "codex.api_request",
      label: "Model · plan",
      status: "ok",
      error: null,
      attributes: {},
    });
    const failing = span({
      error: RAW,
      attributes: { toolName: "exec_command", causedBySpanId: "span-model" },
    });
    const diagnosis = buildDiagnosis(
      trace({ failure: sandboxDenied, spans: [planning, failing] }),
    );
    expect(diagnosis?.causedBy?.spanId).toBe("span-model");
    expect(diagnosis?.where?.spanId).toBe("span-tool");
  });

  it("never blames the agent for a trace that has no attribution", () => {
    const diagnosis = buildDiagnosis(trace({ failure: null }));
    expect(diagnosis?.blame).toBe("environment");
    expect(diagnosis?.kind).toBe("unknown");
  });

  // The case that made the whole feature invisible in practice. A real
  // sandbox denial in this system produced `status: completed` with
  // `failingSpanId: null` — the agent explained the denial and carried on — so
  // gating the diagnosis on the run having failed rendered nothing at all.
  it("diagnoses a run that recovered from a failing step", () => {
    const diagnosis = buildDiagnosis(
      trace({ status: "completed", failure: sandboxDenied }),
    );
    expect(diagnosis).not.toBeNull();
    expect(diagnosis?.outcome).toBe("recovered");
    expect(diagnosis?.kind).toBe("sandbox-denied");
    expect(diagnosis?.where?.spanId).toBe("span-tool");
    expect(diagnosis?.envelope).not.toBeNull();
  });

  it("marks a stopped run as failed rather than recovered", () => {
    expect(
      buildDiagnosis(trace({ status: "failed", failure: sandboxDenied }))
        ?.outcome,
    ).toBe("failed");
    expect(
      buildDiagnosis(trace({ status: "cancelled", failure: sandboxDenied }))
        ?.outcome,
    ).toBe("failed");
  });

  // span.error is a 400-character clip of span.output. Reading the clip first
  // handed the parser a truncated envelope: the header still matched, so it
  // looked parsed, but the payload was cut before the stack trace and the whole
  // diagnosis collapsed into "other output".
  it("diagnoses from the full output rather than the clipped error", () => {
    const clipped = RAW.slice(0, 400) + " …[truncated 2193 chars]";
    const diagnosis = buildDiagnosis(
      trace({
        failure: sandboxDenied,
        spans: [span({ error: clipped, attributes: { output: RAW } })],
      }),
    );
    expect(diagnosis?.raw).toBe(RAW);
    expect(diagnosis?.envelope?.stack.length).toBeGreaterThan(0);
    expect(diagnosis?.envelope?.problems.length).toBeGreaterThan(0);
  });

  it("falls back to the error when a span has no output of its own", () => {
    const diagnosis = buildDiagnosis(
      trace({
        failure: sandboxDenied,
        spans: [
          span({
            name: "codex.error",
            kind: "system",
            error: "Codex reported an unknown error",
            attributes: {},
          }),
        ],
      }),
    );
    expect(diagnosis?.raw).toBe("Codex reported an unknown error");
  });

  it("returns nothing for a clean run with no failing step", () => {
    expect(
      buildDiagnosis(
        trace({ status: "completed", failingSpanId: null, failure: null }),
      ),
    ).toBeNull();
  });

  it("flags a diagnosis resting on truncated evidence", () => {
    const diagnosis = buildDiagnosis(
      trace({ failure: sandboxDenied, evidenceComplete: false }),
    );
    expect(diagnosis?.evidenceComplete).toBe(false);
  });
});

describe("recoveryNote", () => {
  // A run that succeeded on the fifth attempt is not a clean run, and until
  // these events were kept it was indistinguishable from one.
  it("reports errors a successful run recovered from", () => {
    expect(recoveryNote(trace({ status: "completed", recoveredErrorCount: 3 })))
      .toBe("Recovered from 3 errors during this run");
    expect(recoveryNote(trace({ status: "completed", recoveredErrorCount: 1 })))
      .toBe("Recovered from 1 error during this run");
    expect(recoveryNote(trace({ status: "completed" }))).toBeNull();
  });
});
