import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "./redaction.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

const CONVERSATION_ID = "01a03e52-a697-79a1-b344-15a234416b01";
const SECRET = "super-secret-ark-key-000";

const fixtureRaw = await readFile(
  new URL("./__fixtures__/otlp-logs.json", import.meta.url),
  "utf8",
);

function fixture() {
  return JSON.parse(fixtureRaw) as {
    resourceLogs: {
      scopeLogs: {
        logRecords: {
          attributes: { key: string; value: Record<string, unknown> }[];
        }[];
      }[];
    }[];
  };
}

function records(payload: ReturnType<typeof fixture>) {
  return payload.resourceLogs[0]!.scopeLogs[0]!.logRecords;
}

function attribute(
  record: { attributes: { key: string; value: Record<string, unknown> }[] },
  key: string,
) {
  return record.attributes.find((entry) => entry.key === key);
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function makeService() {
  const directory = await mkdtemp(path.join(tmpdir(), "trace-service-"));
  const store = new TraceStore(directory);
  await store.initialize();
  cleanups.push(async () => {
    await store.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const service = new TraceService(store, createRedactor([SECRET]));
  return { store, service };
}

const agent = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Builder",
  instructions: "Help with workspace tasks",
  codexThreadId: null,
};
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("TraceService", () => {
  it("assembles the span tree for a real captured run", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "Count the txt files" });
    service.onRunnerEvent(RUN_ID, {
      type: "thread.started",
      thread_id: CONVERSATION_ID,
    });
    const result = service.ingestLogs(fixture());
    expect(result).toEqual({ accepted: 6, buffered: 0, skipped: 0 });
    service.onRunEnd(RUN_ID, { status: "completed" });

    const trace = store.get(RUN_ID);
    expect(trace?.status).toBe("completed");
    expect(trace?.model).toBe("ep-20260825214935-g65wx");
    expect(trace?.conversationId).toBe(CONVERSATION_ID);
    expect(trace?.usage.inputTokens).toBe(7451);
    expect(trace?.usage.cachedTokens).toBe(6912);

    const names = trace?.spans.map((span) => span.name);
    expect(names).toEqual([
      "agent.run",
      "user.prompt",
      "codex.turn",
      "codex.api_request",
      "tool.exec_command",
    ]);

    const tool = trace?.spans.find((span) => span.name === "tool.exec_command");
    expect(tool?.status).toBe("ok");
    expect(tool?.durationMs).toBe(114);
    expect(tool?.attributes.decision).toBe("approved");
    expect(String(tool?.attributes.arguments)).toContain("ls -la");
    expect(String(tool?.attributes.output)).toContain("alpha.txt");

    for (const span of trace?.spans ?? []) {
      expect(span.status).not.toBe("running");
    }
  });

  it("buffers events that arrive before the thread id is known", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "Count the txt files" });
    const early = service.ingestLogs(fixture());
    expect(early?.buffered).toBe(6);
    expect(store.get(RUN_ID)?.spans).toHaveLength(2);

    service.onRunnerEvent(RUN_ID, {
      type: "thread.started",
      thread_id: CONVERSATION_ID,
    });
    expect(store.get(RUN_ID)?.spans.length).toBeGreaterThan(2);
  });

  it("masks secrets before tool output reaches the store", async () => {
    const { store, service } = await makeService();
    const payload = fixture();
    const toolResult = records(payload)[5]!;
    const output = attribute(toolResult, "output")!;
    output.value = { stringValue: "API_KEY=" + SECRET + "\ndone" };

    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "leak check " + SECRET },
    );
    service.ingestLogs(payload);

    const trace = store.get(RUN_ID);
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(trace?.prompt).toContain("sup");
    const tool = trace?.spans.find((span) => span.name === "tool.exec_command");
    expect(String(tool?.attributes.output)).toContain("API_KEY=sup");
  });

  it("marks the failing step when a run fails", async () => {
    const { store, service } = await makeService();
    const payload = fixture();
    const toolResult = records(payload)[5]!;
    attribute(toolResult, "success")!.value = { stringValue: "false" };
    attribute(toolResult, "output")!.value = {
      stringValue: "rm: cannot remove '/etc': Permission denied",
    };

    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "cleanup" },
    );
    service.ingestLogs(payload);
    service.onRunEnd(RUN_ID, { status: "failed", error: "Codex exited with code 1" });

    const trace = store.get(RUN_ID);
    const tool = trace?.spans.find((span) => span.name === "tool.exec_command");
    expect(trace?.status).toBe("failed");
    expect(tool?.status).toBe("error");
    expect(trace?.failingSpanId).toBe(tool?.id);
  });

  it("records user interventions inside the active trace", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "long task" });
    service.onUserIntervention(agent.id, "terminate");
    service.onRunEnd(RUN_ID, { status: "cancelled" });

    const trace = store.get(RUN_ID);
    expect(
      trace?.spans.some((span) => span.name === "user.intervention"),
    ).toBe(true);
    expect(trace?.status).toBe("cancelled");
    expect(service.onUserIntervention(agent.id, "terminate")).toBeNull();
  });

  it("counts unrecognized events instead of dropping the trace", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "hello" },
    );
    service.ingestLogs({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "codex.brand_new" } },
                    {
                      key: "conversation.id",
                      value: { stringValue: CONVERSATION_ID },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(store.get(RUN_ID)?.unrecognizedEvents).toBe(1);
  });

  it("rejects payloads that are not OTLP", async () => {
    const { service } = await makeService();
    expect(service.ingestLogs("garbage")).toBeNull();
  });
});
