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

    const model = trace?.spans.find(
      (span) => span.name === "codex.api_request",
    );
    expect(model?.label).toBe("Model · plan");
    expect(model?.attributes.phase).toBe("plan");
    expect(String(model?.attributes.context)).toContain("Count the txt files");
    expect(String(model?.attributes.output)).toContain("exec_command");
    expect(String(model?.attributes.output)).toContain("ls -la");

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
    service.onRunEnd(RUN_ID, {
      status: "failed",
      error: "Codex exited with code 1",
    });

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
    expect(trace?.spans.some((span) => span.name === "user.intervention")).toBe(
      true,
    );
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
                    {
                      key: "event.name",
                      value: { stringValue: "codex.brand_new" },
                    },
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

  it("labels model calls by turn phase", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "run test" },
    );

    const logs = (records: Record<string, string>[]) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: records.map((attributes) => ({
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              })),
            },
          ],
        },
      ],
    });

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.api_request",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:40.000Z",
          duration_ms: "100",
        },
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          tool_name: "exec_command",
          call_id: "tool-1",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:42.000Z",
          tool_name: "exec_command",
          call_id: "tool-1",
          duration_ms: "50",
          success: "true",
          arguments: '{"cmd":"ls"}',
          output: "done",
        },
        {
          "event.name": "codex.api_request",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:43.000Z",
          duration_ms: "120",
        },
      ]),
    );
    service.onRunEnd(RUN_ID, { status: "completed", output: "all green" });

    const models =
      store
        .get(RUN_ID)
        ?.spans.filter((span) => span.name === "codex.api_request") ?? [];
    expect(models).toHaveLength(2);
    expect(models[0]?.label).toBe("Model · plan");
    expect(models[1]?.label).toBe("Model · reply");
    expect(models[1]?.attributes.afterTool).toBe("exec_command");
    expect(String(models[0]?.attributes.output)).toContain("exec_command");
    expect(String(models[0]?.attributes.output)).toContain("ls");
    expect(models[1]?.attributes.output).toBe("all green");
    expect(models[1]?.attributes.context).toBe("done");
  });

  it("stores agent_message jsonl as the last model output", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "say hi" },
    );
    service.ingestLogs({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "codex.api_request" },
                    },
                    {
                      key: "conversation.id",
                      value: { stringValue: CONVERSATION_ID },
                    },
                    {
                      key: "event.timestamp",
                      value: { stringValue: "2026-08-26T13:46:40.000Z" },
                    },
                    { key: "duration_ms", value: { stringValue: "80" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    service.onRunnerEvent(RUN_ID, {
      type: "item.completed",
      item: { type: "agent_message", text: "hello there" },
    });
    service.onRunEnd(RUN_ID, { status: "completed", output: "hello there" });

    const model = store
      .get(RUN_ID)
      ?.spans.find((span) => span.name === "codex.api_request");
    expect(model?.attributes.context).toContain("say hi");
    expect(model?.attributes.output).toBe("hello there");
  });

  it("synthesizes subagent result spans from exec_command output", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "Spawn 2 subagents" },
    );

    const logs = (records: Record<string, string>[]) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: records.map((attributes) => ({
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              })),
            },
          ],
        },
      ],
    });

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T23:16:53.579Z",
          tool_name: "exec_command",
          call_id: "exec-sim",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T23:16:54.124Z",
          tool_name: "exec_command",
          call_id: "exec-sim",
          duration_ms: "584",
          success: "true",
          output:
            'Spawning subagent 0 and subagent 1...\n\nAgent-0 returned: {"agentIndex":0,"timestamp":1787786213857}\nAgent-1 returned: {"agentIndex":1,"timestamp":1787786214053}\n',
        },
      ]),
    );

    const trace = store.get(RUN_ID);
    const exec = trace?.spans.find(
      (span) => span.attributes.callId === "exec-sim",
    );
    const results =
      trace?.spans.filter((span) => span.name === "subagent.result") ?? [];

    expect(exec?.attributes.spawnsSubagents).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.map((span) => span.attributes.subagentIndex).sort()).toEqual(
      ["0", "1"],
    );
    for (const result of results) {
      expect(result.parentId).toBe(exec?.id);
    }
  });

  it("records spawn_agent items from codex exec jsonl", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "delegate" });
    service.onRunnerEvent(RUN_ID, {
      type: "item.completed",
      item: {
        id: "collab-spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        status: "completed",
        sender_thread_id: "thread-parent",
        receiver_thread_ids: ["thread-child"],
        prompt: "research task",
      },
    });

    const trace = store.get(RUN_ID);
    const spawn = trace?.spans.find(
      (span) => span.attributes.callId === "collab-spawn-1",
    );
    expect(spawn?.attributes.subagent).toBe(true);
    expect(spawn?.attributes.receiverThreadIds).toBe("thread-child");
  });

  it("nests subagent spans under spawn_agent tools", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "delegate research" },
    );

    const logs = (records: Record<string, string>[]) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: records.map((attributes) => ({
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              })),
            },
          ],
        },
      ],
    });

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:40.000Z",
          tool_name: "spawn_agent",
          call_id: "spawn-1",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.api_request",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          duration_ms: "100",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:42.000Z",
          tool_name: "spawn_agent",
          call_id: "spawn-1",
          duration_ms: "5000",
          success: "true",
          arguments: '{"agent_type":"worker","task_name":"research"}',
          output: "done",
        },
      ]),
    );

    const trace = store.get(RUN_ID);
    const spawn = trace?.spans.find(
      (span) => span.attributes.callId === "spawn-1",
    );
    const nestedModel = trace?.spans.find(
      (span) => span.name === "codex.api_request",
    );

    expect(spawn?.attributes.subagent).toBe(true);
    expect(spawn?.attributes.subagentType).toBe("worker");
    expect(nestedModel?.parentId).toBe(spawn?.id);
  });

  it("nests subagent spans under Task tools, including nested subagents", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "research task" },
    );

    const logs = (records: Record<string, string>[]) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: records.map((attributes) => ({
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              })),
            },
          ],
        },
      ],
    });

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:40.000Z",
          tool_name: "Task",
          call_id: "outer-task",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.api_request",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          duration_ms: "100",
        },
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:42.000Z",
          tool_name: "Task",
          call_id: "inner-task",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:43.000Z",
          tool_name: "exec_command",
          call_id: "inner-exec",
          duration_ms: "50",
          success: "true",
          output: "done",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:44.000Z",
          tool_name: "Task",
          call_id: "inner-task",
          duration_ms: "2000",
          success: "true",
          arguments: '{"subagent_type":"explore"}',
          output: "inner complete",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:45.000Z",
          tool_name: "Task",
          call_id: "outer-task",
          duration_ms: "5000",
          success: "true",
          arguments: '{"subagent_type":"generalPurpose"}',
          output: "outer complete",
        },
      ]),
    );

    const trace = store.get(RUN_ID);
    const spanByName = new Map(trace?.spans.map((span) => [span.name, span]));
    const turn = spanByName.get("codex.turn");
    const outerTask = trace?.spans.find(
      (span) => span.attributes.callId === "outer-task",
    );
    const innerTask = trace?.spans.find(
      (span) => span.attributes.callId === "inner-task",
    );
    const outerModel = spanByName.get("codex.api_request");
    const innerExec = trace?.spans.find(
      (span) => span.attributes.callId === "inner-exec",
    );

    expect(outerTask?.parentId).toBe(turn?.id);
    expect(outerModel?.parentId).toBe(outerTask?.id);
    expect(innerTask?.parentId).toBe(outerTask?.id);
    expect(innerExec?.parentId).toBe(innerTask?.id);
    expect(outerTask?.attributes.subagent).toBe(true);
    expect(innerTask?.attributes.subagent).toBe(true);
    expect(outerTask?.attributes.subagentType).toBe("generalPurpose");
    expect(innerTask?.attributes.subagentType).toBe("explore");
  });
});
