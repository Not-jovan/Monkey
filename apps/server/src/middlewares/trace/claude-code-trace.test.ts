import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCodeRuntime,
  parseClaudeCodeEventLine,
} from "../../runtimes/claude-code.js";
import type { ParsedEvents } from "../../runtimes/types.js";
import { createRedactor } from "./redaction.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

// Captured from a live `claude -p --output-format stream-json --verbose
// --permission-mode bypassPermissions` run (CLI 2.1.251) against a throwaway
// OTLP collector: the agent ran `ls -la` with Bash and then read a file. Two
// export bodies, 12 records. Prompt/response text and account identifiers were
// stripped; every attribute this pipeline reads is untouched.
const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "__fixtures__",
      "claude-code-otlp-logs.json",
    ),
    "utf8",
  ),
) as { resourceLogs: unknown[] };

// The run's own stdout, of which only the session-announcing line matters here.
const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "612d1c5d-7a46-4f81-9142-b9bc63f3e434",
  model: "claude-sonnet-5",
});

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    // The store persists spans in the background, so the directory can still
    // be gaining files when the last assertion returns.
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

function makeService() {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-trace-"));
  directories.push(directory);
  const store = new TraceStore(directory);
  const traces = new TraceService(
    store,
    createRedactor([]),
    claudeCodeRuntime.trace,
  );
  // A brand-new agent: no stored session id, which is the case that was
  // completely broken — nothing bound, so nothing correlated.
  traces.onRunStart(
    { id: "agent-1", name: "Fixture", instructions: "", codexThreadId: null },
    { id: RUN_ID, prompt: "run ls with Bash, then read notes.txt" },
  );
  return { store, traces };
}

function ingestFixture(traces: TraceService) {
  return (fixture.resourceLogs as unknown[]).map((resourceLog) =>
    traces.ingestLogs({ resourceLogs: [resourceLog] }),
  );
}

describe("Claude Code trace pipeline", () => {
  it("attaches the whole run once the session id arrives", () => {
    const { store, traces } = makeService();
    const parsed: ParsedEvents = {
      messages: [],
      threadId: null,
      usage: null,
      errors: [],
      model: null,
    };

    parseClaudeCodeEventLine(INIT_LINE, parsed, () => {});
    expect(parsed.threadId).toBe("612d1c5d-7a46-4f81-9142-b9bc63f3e434");
    traces.onConversation(RUN_ID, parsed.threadId!);

    const results = ingestFixture(traces);
    expect(results.reduce((total, r) => total + (r?.accepted ?? 0), 0)).toBe(12);
    expect(results.every((result) => result?.buffered === 0)).toBe(true);

    const trace = store.get(RUN_ID);
    expect(trace?.conversationId).toBe("612d1c5d-7a46-4f81-9142-b9bc63f3e434");
    expect(trace?.spans.filter((span) => span.kind === "tool_call").map((span) => span.name))
      .toEqual(["tool.Bash", "tool.Read"]);
    // Input is all this runtime's OTLP carries for a tool call — no output
    // field exists on the signal, only sizes.
    const bash = trace?.spans.find((span) => span.name === "tool.Bash");
    expect(bash?.status).toBe("ok");
    expect(String(bash?.attributes.arguments)).toContain("ls -la");
  });

  // Telemetry outruns stdout: records for a turn can reach the collector
  // before the line announcing the session does. They are held, not dropped —
  // which is also why the missing announcement was silent rather than loud.
  it("holds records that arrive before the session id and replays them", () => {
    const { store, traces } = makeService();

    const results = ingestFixture(traces);
    // Correlation itself was never the problem: session.id is on every
    // record, so nothing is *skipped*. The records simply had no run to
    // attach to, leaving a trace with a prompt and none of the agent's work.
    expect(results.every((result) => result?.skipped === 0)).toBe(true);
    expect(results.reduce((total, r) => total + (r?.buffered ?? 0), 0)).toBe(12);
    expect(store.get(RUN_ID)?.spans).toHaveLength(2);

    traces.onConversation(RUN_ID, "612d1c5d-7a46-4f81-9142-b9bc63f3e434");

    expect(
      store.get(RUN_ID)?.spans.filter((span) => span.kind === "tool_call"),
    ).toHaveLength(2);
  });

  it("keeps the CLI's own background calls out of the agent's trace", () => {
    const { store, traces } = makeService();
    traces.onConversation(RUN_ID, "612d1c5d-7a46-4f81-9142-b9bc63f3e434");

    ingestFixture(traces);

    const trace = store.get(RUN_ID);
    // The capture contains a `generate_session_title` call on haiku that cost
    // 926 input tokens. Counting it would both invent a model-call span the
    // agent never made and bill its tokens to the run.
    expect(trace?.spans.filter((span) => span.kind === "model_call")).toHaveLength(3);
    expect(trace?.usage.inputTokens).toBeLessThan(100);
    // retention_sweep is housekeeping we recognize and drop on purpose; it
    // must not be reported as an event the platform failed to understand.
    expect(trace?.unrecognizedEvents).toBe(0);
  });

  it("names the turn after the runtime that ran it", () => {
    const { store, traces } = makeService();
    traces.onConversation(RUN_ID, "612d1c5d-7a46-4f81-9142-b9bc63f3e434");

    ingestFixture(traces);

    const turn = store.get(RUN_ID)?.spans.find((span) => span.kind === "turn");
    expect(turn?.name).toBe("claude-code.turn");
    expect(turn?.label).toBe("Claude Code turn");
  });
});
