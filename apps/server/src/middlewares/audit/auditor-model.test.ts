import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArkAbortError, ArkApiError } from "../../ark-client.js";
import type { AgentRunner, RunnerRequest } from "../../types.js";
import { AuditorModel, auditorCallSpan, auditorSubagentType, describeError, summarizeError } from "./auditor-model.js";

const verdict = z.object({ ok: z.boolean() });
const ANSWER = JSON.stringify({ ok: true });

const notActivated = (requestId: string) =>
  new ArkApiError(
    "Your account has not activated the model primary-model. " +
      "Please activate the model service in the Ark Console. Request id: " +
      requestId,
    "ModelNotOpen",
    404,
  );

// Where the auditor is running, which every call now carries. The in-process
// runner ignores the workspace; it is here because AgentRunner asks for one.
const RUN = { agentId: "agent-1", workspacePath: "/data/agent-runs/agent-1/chat-1" };

// Counts the calls so a test can tell a request that was made from one the
// remembered outage skipped.
function fakeRunner(): AgentRunner & { models: string[] } {
  const models: string[] = [];
  return {
    models,
    run: async ({ model }) => {
      const named = model ?? "";
      models.push(named);
      if (named === "primary-model") {
        throw notActivated("request-id-" + models.length);
      }
      return { output: ANSWER, threadId: null, usage: null, model: named };
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
}

describe("summarizeError", () => {
  // The provider stamps a fresh id on every response, so seven checks reporting
  // one outage produced seven strings that no consumer could group.
  it("drops the per-response request id that describeError keeps", () => {
    const error = notActivated("request-id-1");

    expect(describeError(error)).toContain("Request id:");
    expect(summarizeError(error)).toBe(
      "ModelNotOpen: Your account has not activated the model primary-model. " +
        "Please activate the model service in the Ark Console.",
    );
  });

  it("reports two different outages as two different summaries", () => {
    const left = summarizeError(notActivated("aaa"));
    const right = summarizeError(
      new ArkApiError("Rate limited", "TooManyRequests", 429),
    );

    expect(left).not.toBe(right);
  });

  it("groups timeouts by phase rather than by in-flight count", () => {
    const timing = {
      promptBytes: 10,
      inFlightAtStart: 22,
      headersMs: null,
      ttftMs: null,
      lastChunkMs: null,
      chunkCount: 0,
      requestId: null,
      abortPhase: "waiting_for_headers" as const,
    };
    const first = new ArkAbortError(
      "Audit model timed out after 60s waiting for headers (22 in flight)",
      "timeout",
      "Audit model timed out after 60s waiting for headers",
      { ...timing, inFlightAtStart: 22 },
      "",
      null,
    );
    const second = new ArkAbortError(
      "Audit model timed out after 60s waiting for headers (7 in flight)",
      "timeout",
      "Audit model timed out after 60s waiting for headers",
      { ...timing, inFlightAtStart: 7 },
      "",
      null,
    );

    expect(summarizeError(first)).toBe(summarizeError(second));
    expect(describeError(first)).toContain("22 in flight");
  });
});

describe("AuditorModel.complete request shape", () => {
  // Records what the runner was actually asked for.
  function recordingRunner(): AgentRunner & { requests: RunnerRequest[] } {
    const requests: RunnerRequest[] = [];
    return {
      requests,
      run: async (request) => {
        requests.push(request);
        const named = request.model ?? "";
        return { output: ANSWER, threadId: null, usage: null, model: named };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
  }

  // The provider caches on a common leading prefix, so several checks can only
  // share one if what reaches the runner is exactly what the caller composed:
  // the shared system turn, then the shared evidence, then the question that
  // trails it. Anything this model added of its own would sit in between.
  it("passes the caller's system turn and prompt through untouched", async () => {
    const runner = recordingRunner();
    const model = new AuditorModel(runner);

    const composed = "evidence\n\nthe question";
    await model.complete(RUN, "good-model", null, "s", composed, verdict);

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      system: "s",
      prompt: composed,
      model: "good-model",
      threadId: null,
    });
  });
});

describe("AuditorModel.complete", () => {
  it("gives every check the same words for one outage", async () => {
    const runner = fakeRunner();
    const model = new AuditorModel(runner);
    const ask = () =>
      model.complete(RUN, "primary-model", "fallback-model", "s", "u", verdict);

    // Concurrent, the way one step's checks actually run: all three reach the
    // provider before any of them learns the model is gone, so each is handed
    // its own request id.
    const concurrent = await Promise.all([ask(), ask(), ask()]);

    expect(new Set(concurrent.map((answer) => answer.failure)).size).toBe(1);
    expect(concurrent[0]?.status).toBe("degraded");
    expect(concurrent[0]?.failure).toBe(
      "Primary audit model unavailable: ModelNotOpen: Your account has not " +
        "activated the model primary-model. Please activate the model service " +
        "in the Ark Console.",
    );
  });

  it("repeats the remembered reason rather than a bare not-available", async () => {
    const runner = fakeRunner();
    const model = new AuditorModel(runner);
    const first = await model.complete(
      RUN,
      "primary-model",
      "fallback-model",
      "s",
      "u",
      verdict,
    );
    const calls = runner.models.length;

    const later = await model.complete(
      RUN,
      "primary-model",
      "fallback-model",
      "s",
      "u",
      verdict,
    );

    // The primary is not tried again, and what the check reports does not
    // change just because it skipped the call.
    expect(runner.models.slice(calls)).not.toContain("primary-model");
    expect(later.failure).toBe(first.failure);
  });

  // The attempt is what the auditor's own span shows, and an operator taking a
  // failure to the provider needs the id the summary drops.
  it("keeps the request id on the attempt it summarised away", async () => {
    const runner = fakeRunner();
    const model = new AuditorModel(runner);

    const answer = await model.complete(
      RUN,
      "primary-model",
      "fallback-model",
      "s",
      "u",
      verdict,
    );

    expect(answer.failure).not.toContain("Request id:");
    expect(
      answer.attempts.some((attempt) => attempt.error?.includes("Request id:")),
    ).toBe(true);
  });

  it("keeps timeout timing and partial output on the attempt", async () => {
    const timing = {
      promptBytes: 12,
      inFlightAtStart: 3,
      headersMs: 12,
      ttftMs: 40,
      lastChunkMs: 50,
      chunkCount: 2,
      requestId: "req-9",
      abortPhase: "streaming" as const,
    };
    const runner: AgentRunner = {
      run: async () => {
        throw new ArkAbortError(
          "Audit model timed out after 60s; first token at 0.0s, 2 chunks (3 in flight)",
          "timeout",
          "Audit model timed out after 60s while streaming",
          timing,
          '{"ok":',
          null,
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const model = new AuditorModel(runner);

    const answer = await model.complete(
      RUN,
      "flash",
      null,
      "s",
      "u",
      verdict,
    );

    expect(answer.status).toBe("failed");
    expect(answer.failure).toBe(
      "Audit model timed out after 60s while streaming",
    );
    expect(answer.attempts[0]?.content).toBe('{"ok":');
    expect(answer.attempts[0]?.timing).toEqual(timing);
    expect(answer.attempts[0]?.error).toContain("3 in flight");
  });

  it("uses a verdict that was already in the reasoning when the stall fired", async () => {
    const timing = {
      promptBytes: 12,
      inFlightAtStart: 1,
      headersMs: 12,
      ttftMs: null,
      lastChunkMs: 60_000,
      chunkCount: 100,
      requestId: "req-think",
      abortPhase: "streaming" as const,
    };
    const runner: AgentRunner = {
      run: async () => {
        throw new ArkAbortError(
          "Audit model reasoned for 60.0s without an answer; headers at 0.0s, 100 chunks (1 in flight)",
          "timeout",
          "Audit model timed out after 60s; stream opened, no answer text",
          timing,
          'scratching around\n{"ok":true}',
          null,
        );
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const model = new AuditorModel(runner);

    const answer = await model.complete(
      RUN,
      "flash",
      null,
      "s",
      "u",
      verdict,
    );

    expect(answer.status).toBe("completed");
    expect(answer.verdict).toEqual({ ok: true });
    expect(answer.attempts[0]?.error).toBeNull();
    expect(answer.attempts[0]?.content).toContain('{"ok":true}');
  });
});

describe("auditorCallSpan", () => {
  const attempt = {
    model: "ep-audit",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:01.000Z",
    durationMs: 1_000,
    content: "{}",
    error: null,
    usage: null,
  };

  it("leaves lane and parent unset so the tracer stamps them", () => {
    const span = auditorCallSpan({
      traceId: "audit-1",
      name: "audit.step.intent",
      label: "Intent · Model · plan",
      targetSpanId: "span-1",
      prompt: "judge this",
      attempt,
      fallback: false,
    });
    expect(span.parentId).toBeNull();
    expect(span.attributes.laneId).toBeUndefined();
    expect(span.attributes.phase).toBe("step");
  });

  // The figure was parsed all the way from the provider and then dropped
  // here, so an auditor read as uncached no matter what the provider did.
  it("carries a cache hit onto the span under the name the trace page reads", () => {
    const span = auditorCallSpan({
      traceId: "audit-1",
      name: "audit.step.summary",
      label: "Summarize · Model · plan",
      targetSpanId: "span-1",
      prompt: "judge this",
      attempt: {
        ...attempt,
        usage: {
          inputTokens: 18_000,
          cachedInputTokens: 17_800,
          outputTokens: 12,
        },
      },
      fallback: false,
    });
    expect(span.attributes.inputTokens).toBe(18_000);
    expect(span.attributes.cachedTokens).toBe(17_800);
  });

  it("omits the cache attribute when the provider reported none", () => {
    const span = auditorCallSpan({
      traceId: "audit-1",
      name: "audit.step.summary",
      label: "Summarize · Model · plan",
      targetSpanId: "span-1",
      prompt: "judge this",
      attempt: { ...attempt, usage: { inputTokens: 18_000 } },
      fallback: false,
    });
    expect(span.attributes).not.toHaveProperty("cachedTokens");
  });

  it("marks run-level calls as the auditor's own work", () => {
    const span = auditorCallSpan({
      traceId: "audit-1",
      name: "audit.forward-trace",
      label: "Forward trace · 2 directive(s)",
      targetSpanId: null,
      prompt: "judge the run",
      attempt,
      fallback: false,
    });
    expect(span.attributes.phase).toBe("run");
    expect(auditorSubagentType(span.name)).toBeUndefined();
  });

  it("copies provider timing onto the span the inspector already shows", () => {
    const span = auditorCallSpan({
      traceId: "audit-1",
      name: "audit.step.intent",
      label: "Intent · Model · plan",
      targetSpanId: "span-1",
      prompt: "judge this",
      attempt: {
        ...attempt,
        error: "Audit model timed out after 60s waiting for headers (22 in flight)",
        timing: {
          promptBytes: 7200,
          inFlightAtStart: 22,
          headersMs: null,
          ttftMs: null,
          lastChunkMs: null,
          chunkCount: 0,
          requestId: null,
          abortPhase: "waiting_for_headers",
        },
      },
      fallback: false,
    });

    expect(span.attributes.promptBytes).toBe(7200);
    expect(span.attributes.inFlightAtStart).toBe(22);
    expect(span.attributes.abortPhase).toBe("waiting_for_headers");
    expect(span.attributes.chunkCount).toBe(0);
    expect(span.attributes.headersMs).toBeUndefined();
  });
});

describe("auditorSubagentType", () => {
  it("maps step checks to the spawn_agent type Codex would record", () => {
    expect(auditorSubagentType("audit.step.summary")).toBe("summarize");
    expect(auditorSubagentType("audit.step.tool")).toBe("tool misuse");
    expect(auditorSubagentType("audit.identify")).toBe("identify");
    expect(auditorSubagentType("audit.forward-trace")).toBeUndefined();
  });
});
