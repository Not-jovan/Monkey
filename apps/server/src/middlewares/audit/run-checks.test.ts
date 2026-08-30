import { describe, expect, it } from "vitest";
import type { TraceRecord, TraceSpan } from "../trace/trace-model.js";
import { emptyUsage } from "../trace/trace-model.js";
import { buildMetaContext } from "./run-checks.js";

function span(overrides: Partial<TraceSpan> & { id: string }): TraceSpan {
  return {
    traceId: "trace-1",
    parentId: null,
    name: "audit.step",
    label: "Audit · " + overrides.id,
    kind: "model_call",
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

function trace(spans: TraceSpan[]): TraceRecord {
  return {
    version: 1,
    id: "trace-1",
    agentId: "agent-1",
    conversationId: null,
    status: "completed",
    startedAt: "2026-08-27T00:00:00.000Z",
    endedAt: "2026-08-27T00:00:01.000Z",
    prompt: "count the files",
    model: null,
    usage: emptyUsage(),
    failingSpanId: null,
    failure: null,
    recoveredErrorCount: 0,
    evidenceComplete: true,
    unrecognizedEvents: 0,
    auditOf: null,
    auditDepth: 0,
    spans,
  };
}

describe("buildMetaContext", () => {
  it("names every step when the run is within the cap", () => {
    const spans = [span({ id: "a" }), span({ id: "b" })];
    const prompt = buildMetaContext(trace(spans), spans);
    expect(prompt).toContain("## Auditor steps (2)");
    expect(prompt).not.toContain("most recent shown");
    expect(prompt).toContain("### 1. Audit · a");
    expect(prompt).toContain("### 2. Audit · b");
  });

  it("keeps only the most recent steps and says how many were omitted", () => {
    const total = 45;
    const spans = Array.from({ length: total }, (_, index) =>
      span({ id: "step-" + (index + 1) }),
    );
    const prompt = buildMetaContext(trace(spans), spans);

    expect(prompt).toContain(
      "## Auditor steps (40 of " + total + ", most recent shown)",
    );
    expect(prompt).not.toContain("Audit · step-1 [");
    expect(prompt).not.toContain("Audit · step-5 [");
    expect(prompt).toContain("### 6. Audit · step-6");
    expect(prompt).toContain(
      "### " + total + ". Audit · step-" + total,
    );
  });
});
