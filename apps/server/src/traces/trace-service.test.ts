import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedactor } from "./redaction.js";
import { codexRuntime } from "../runtimes/codex.js";
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
  const service = new TraceService(store, createRedactor([SECRET]), codexRuntime.trace);
  return { store, service };
}

const agent = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Builder",
  instructions: "Help with workspace tasks",
  codexThreadId: null,
};
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Wraps OTLP log attributes in the envelope the collector receives. Was copied
// verbatim into every test that needed it.
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

describe("TraceService", () => {
  it("assembles the span tree for a real captured run", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "Count the txt files" });
    service.onConversation(RUN_ID, CONVERSATION_ID);
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
    expect(model?.attributes.inputTokens).toBe(7451);
    expect(model?.attributes.cachedTokens).toBe(6912);

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

    service.onConversation(RUN_ID, CONVERSATION_ID);
    expect(store.get(RUN_ID)?.spans.length).toBeGreaterThan(2);
  });

  it("keeps the human message when telemetry carries a wrapped runtime prompt", async () => {
    const { store, service } = await makeService();
    const humanPrompt = "Add a troubleshooting section";
    const runtimePrompt = [
      "Standing intent for this Agent:",
      "Do not contact hosts outside the whitelist.",
      "Current user request:",
      humanPrompt,
    ].join("\n");
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: humanPrompt },
    );
    service.ingestLogs(
      logs([
        {
          "event.name": "codex.user_prompt",
          "conversation.id": CONVERSATION_ID,
          prompt_length: String(runtimePrompt.length),
          prompt: runtimePrompt,
        },
      ]),
    );

    const prompt = store
      .get(RUN_ID)
      ?.spans.find((span) => span.name === "user.prompt");
    expect(prompt?.attributes.prompt).toBe(humanPrompt);
    expect(prompt?.attributes.promptLength).toBe(humanPrompt.length);
    expect(prompt?.attributes.runtimePromptLength).toBe(runtimePrompt.length);
    expect(prompt?.attributes.runtimePromptWrapped).toBe(true);
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
  });

  it("records a stop on the latest chat when no run is in flight", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "done already" });
    service.onRunEnd(RUN_ID, { status: "completed" });

    const span = service.onUserIntervention(agent.id, "terminate");
    expect(span?.name).toBe("user.intervention");
    expect(span?.attributes.action).toBe("terminate");

    const trace = store.get(RUN_ID);
    expect(trace?.spans.some((item) => item.name === "user.intervention")).toBe(
      true,
    );
    expect(
      trace?.spans.find((item) => item.name === "user.intervention")?.parentId,
    ).toBe(trace?.spans.find((item) => item.name === "agent.run")?.id);
  });

  it("does not invent a chat just to record a stop", async () => {
    const { service } = await makeService();
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

  it("treats exec_command as a command, even when the shell-out is a nested codex exec", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "Spawn 2 subagents" },
    );

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

    expect(exec?.attributes.spawnsSubagents).toBeUndefined();
    expect(exec?.attributes.subagent).toBeUndefined();
    expect(exec?.label).toBe("Tool · exec_command");
    expect(results).toHaveLength(0);
  });

  it("does not treat nested codex exec as a subagent spawn", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "Spawn 2 subagents" },
    );

    const nestedOutput = [
      "Chunk ID: 6edb91",
      "Wall time: 0.1258 seconds",
      "Process exited with code 0",
      "Original token count: 175",
      "Output:",
      "OpenAI Codex v0.111.0 (research preview)",
      "--------",
      "session id: 01a04661-1c24-7300-8a06-bc071933d9ac",
      "--------",
      "codex",
      "Hello 1",
    ].join("\n");

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-28T03:19:24.322Z",
          tool_name: "exec_command",
          call_id: "nested-exec",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.api_request",
          "conversation.id": "01a04661-1c24-7300-8a06-bc071933d9ac",
          "event.timestamp": "2026-08-28T03:19:24.400Z",
          duration_ms: "80",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-28T03:19:24.607Z",
          tool_name: "exec_command",
          call_id: "nested-exec",
          duration_ms: "313",
          success: "true",
          arguments:
            '{"cmd": "codex exec --sandbox danger-full-access --ephemeral \'Just say \\\"Hello 1\\\" - do not run any command\'", "max_output_tokens": 200}',
          output: nestedOutput,
        },
      ]),
    );

    const trace = store.get(RUN_ID);
    const exec = trace?.spans.find(
      (span) => span.attributes.callId === "nested-exec",
    );
    const result = trace?.spans.find((span) => span.name === "subagent.result");
    const nestedModel = trace?.spans.find(
      (span) => span.name === "codex.api_request",
    );

    expect(exec?.attributes.subagent).toBeUndefined();
    expect(exec?.label).toBe("Tool · exec_command");
    expect(exec?.attributes.receiverThreadIds).toBeUndefined();
    expect(result).toBeUndefined();
    expect(nestedModel).toBeUndefined();
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
          "conversation.id": "thread-child",
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
          arguments:
            '{"agent_type":"worker","task_name":"research","thread_id":"thread-child"}',
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

  it("parents child-conversation events under the spawn that bound them", async () => {
    const { store, service } = await makeService();
    service.onRunStart(
      { ...agent, codexThreadId: CONVERSATION_ID },
      { id: RUN_ID, prompt: "delegate two workers" },
    );

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:40.000Z",
          tool_name: "spawn_agent",
          call_id: "spawn-a",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.tool_decision",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:40.100Z",
          tool_name: "spawn_agent",
          call_id: "spawn-b",
          decision: "approved",
          source: "Config",
        },
        {
          "event.name": "codex.api_request",
          "conversation.id": "thread-child-a",
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          duration_ms: "80",
        },
        {
          "event.name": "codex.api_request",
          "conversation.id": "thread-child-b",
          "event.timestamp": "2026-08-26T13:46:41.050Z",
          duration_ms: "90",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:42.000Z",
          tool_name: "spawn_agent",
          call_id: "spawn-a",
          duration_ms: "2000",
          success: "true",
          arguments: '{"agent_type":"worker","thread_id":"thread-child-a"}',
          output: "a done",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:42.100Z",
          tool_name: "spawn_agent",
          call_id: "spawn-b",
          duration_ms: "2100",
          success: "true",
          arguments: '{"agent_type":"reviewer","thread_id":"thread-child-b"}',
          output: "b done",
        },
      ]),
    );

    const trace = store.get(RUN_ID);
    const spawnA = trace?.spans.find(
      (span) => span.attributes.callId === "spawn-a",
    );
    const spawnB = trace?.spans.find(
      (span) => span.attributes.callId === "spawn-b",
    );
    const childModels =
      trace?.spans.filter((span) => span.name === "codex.api_request") ?? [];

    expect(spawnA?.attributes.laneId).toBe("root");
    expect(spawnB?.attributes.laneId).toBe("root");
    expect(childModels).toHaveLength(2);
    expect(childModels[0]?.parentId).toBe(spawnA?.id);
    expect(childModels[1]?.parentId).toBe(spawnB?.id);
    expect(childModels[0]?.attributes.laneId).toBe(spawnA?.id);
    expect(childModels[1]?.attributes.laneId).toBe(spawnB?.id);
    expect(childModels[0]?.label).toContain("Subagent model");
    expect(childModels[1]?.label).toContain("Subagent model");
  });

  it("binds receiver_thread_ids from spawn_agent jsonl onto the parent run", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "delegate" });
    service.onConversation(RUN_ID, CONVERSATION_ID);
    service.onRunnerEvent(RUN_ID, {
      type: "item.completed",
      item: {
        id: "collab-spawn-1",
        type: "collab_tool_call",
        tool: "spawn_agent",
        status: "completed",
        sender_thread_id: CONVERSATION_ID,
        receiver_thread_ids: ["thread-child"],
        prompt: "research task",
      },
    });

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.api_request",
          "conversation.id": "thread-child",
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          duration_ms: "100",
        },
      ]),
    );

    const trace = store.get(RUN_ID);
    const spawn = trace?.spans.find(
      (span) => span.attributes.callId === "collab-spawn-1",
    );
    const childModel = trace?.spans.find(
      (span) => span.name === "codex.api_request",
    );
    expect(spawn?.attributes.receiverThreadIds).toBe("thread-child");
    expect(childModel?.parentId).toBe(spawn?.id);
    expect(childModel?.attributes.laneId).toBe(spawn?.id);
  });

  // parseCodexEventLine collected these and the runners read only the last one,
  // and only on a non-zero exit — so every error a run recovered from was
  // discarded before it could be seen or audited.
  it("keeps the errors Codex reports on its own event stream", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "install the deps" });

    service.onRunnerEvent(RUN_ID, {
      type: "error",
      message: "npm ERR! network timeout",
    });
    service.onRunnerEvent(RUN_ID, {
      type: "turn.failed",
      error: { message: "retrying after a stream reset" },
    });
    service.onRunEnd(RUN_ID, { status: "completed", output: "installed" });

    const trace = store.get(RUN_ID);
    const errors = trace?.spans.filter((span) => span.name === "codex.error");
    expect(errors).toHaveLength(2);
    expect(errors?.[0]?.status).toBe("error");
    expect(errors?.[0]?.error).toBe("npm ERR! network timeout");
    expect(errors?.[1]?.error).toBe("retrying after a stream reset");
    // The run succeeded, so both were recovered from.
    expect(trace?.recoveredErrorCount).toBe(2);
    expect(trace?.status).toBe("completed");
  });

  it("masks a credential that appears in a stream error", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "deploy" });
    service.onRunnerEvent(RUN_ID, {
      type: "error",
      message: "auth failed for " + SECRET,
    });
    service.onRunEnd(RUN_ID, { status: "completed", output: "done" });

    const error = store
      .get(RUN_ID)
      ?.spans.find((span) => span.name === "codex.error");
    expect(error?.error).not.toContain(SECRET);
  });

  // On a failed run the last error is the outcome, not something survived.
  it("records attribution on a failed run and claims no recovery", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "serve on port 8080" });
    service.onRunnerEvent(RUN_ID, { type: "error", message: "SandboxDenied" });
    service.onRunEnd(RUN_ID, {
      status: "failed",
      error: "sandbox denied",
      failure: {
        layer: "policy",
        kind: "sandbox-denied",
        retryability: "user-action",
        title: "The Runtime sandbox denied this operation",
        detail: "listen EPERM",
        remedy: "Keep the work inside /workspace.",
        exitCode: 1,
      },
    });

    const trace = store.get(RUN_ID);
    expect(trace?.failure?.kind).toBe("sandbox-denied");
    expect(trace?.recoveredErrorCount).toBe(0);
    const root = trace?.spans.find((span) => span.name === "agent.run");
    expect(root?.attributes.failureLayer).toBe("policy");
    expect(root?.attributes.retryability).toBe("user-action");
    // The stream error is the most recent failing span, so it is what the UI
    // points at.
    expect(trace?.failingSpanId).toBeTruthy();
  });

  // The case the whole diagnosis feature was invisible for: a real sandbox
  // denial in this system leaves the run "completed", because the agent
  // explains the denial and carries on. Nothing about it can be diagnosed if
  // the failing step is only recorded when the run itself stopped.
  it("records the failing step even when the run completed", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "serve on port 8080" });
    service.onRunnerEvent(RUN_ID, {
      type: "error",
      message:
        'exec_command failed: SandboxDenied { message: "listen EPERM 0.0.0.0:8080" }',
    });
    service.onRunEnd(RUN_ID, {
      status: "completed",
      output: "I could not bind the port, so I documented how to run it locally.",
    });

    const trace = store.get(RUN_ID);
    expect(trace?.status).toBe("completed");
    expect(trace?.failingSpanId).not.toBeNull();
    // Attributed from the step, with no run-level failure to inherit from.
    expect(trace?.failure?.layer).toBe("policy");
    expect(trace?.failure?.kind).toBe("sandbox-denied");
    expect(trace?.recoveredErrorCount).toBe(1);
  });

  it("leaves a genuinely clean run unmarked", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "write the docs" });
    service.onRunEnd(RUN_ID, { status: "completed", output: "done" });

    const trace = store.get(RUN_ID);
    expect(trace?.failingSpanId).toBeNull();
    expect(trace?.failure).toBeNull();
  });

  // Codex reports a tool call as successful whenever the *tool* ran — a command
  // that exits 127 with "command not found" arrives as success:"true". That made
  // the agent's own failures invisible: the one thing the taxonomy exists to
  // identify never produced a failing step, so the layer could only ever say
  // "not the agent".
  it("marks a command that failed inside a successful tool call", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "probe the sandbox" });
    service.onConversation(RUN_ID, CONVERSATION_ID);

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          tool_name: "exec_command",
          call_id: "tool-1",
          duration_ms: "50",
          success: "true",
          arguments: "{\"cmd\":\"frobnicate --all\"}",
          output: "Chunk ID: aebf5d\nWall time: 0.0512 seconds\nProcess exited with code 127\nOriginal token count: 13\nOutput:\n/bin/bash: line 1: frobnicate: command not found\n",
        },
      ]),
    );
    service.onRunEnd(RUN_ID, { status: "completed", output: "done" });

    const trace = store.get(RUN_ID);
    const tool = trace?.spans.find((span) => span.kind === "tool_call");
    expect(tool?.status).toBe("error");
    expect(tool?.attributes.exitCode).toBe(127);
    // The real output is kept as the evidence, not a friendly restatement of
    // it — the classifier and the UI both read this field.
    expect(tool?.error).toContain("frobnicate: command not found");
    // With no other failure, the run's attribution is the agent's own work.
    expect(trace?.failure?.layer).toBe("agent");
    expect(trace?.failure?.kind).toBe("tool-failed");
    expect(trace?.failingSpanId).toBe(tool?.id);
  });

  // A non-zero exit on its own is ordinary control flow: grep finding nothing,
  // diff seeing a difference. Only a recognisable failure signature counts.
  it("leaves a benign non-zero exit alone", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "search the workspace" });
    service.onConversation(RUN_ID, CONVERSATION_ID);

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          tool_name: "exec_command",
          call_id: "tool-1",
          duration_ms: "50",
          success: "true",
          arguments: "{\"cmd\":\"grep -q nothing README.md\"}",
          output: "Chunk ID: b1c2d3\nWall time: 0.0102 seconds\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n",
        },
      ]),
    );
    service.onRunEnd(RUN_ID, { status: "completed", output: "no matches" });

    const trace = store.get(RUN_ID);
    const tool = trace?.spans.find((span) => span.kind === "tool_call");
    expect(tool?.status).toBe("ok");
    // The fact is still recorded, it is simply not treated as a failure.
    expect(tool?.attributes.exitCode).toBe(1);
    expect(trace?.failure).toBeNull();
    expect(trace?.recoveredErrorCount).toBe(0);
  });

  // Counted from the steps that failed, not from Codex stream events. A denied
  // command arrives as a tool result, not as a stream error, so the old tally
  // read zero on runs that had visibly recovered several times.
  it("counts recovered errors from the steps that actually failed", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "probe the sandbox" });
    service.onConversation(RUN_ID, CONVERSATION_ID);

    service.ingestLogs(
      logs([
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:41.000Z",
          tool_name: "exec_command",
          call_id: "tool-1",
          duration_ms: "50",
          success: "true",
          arguments: "{\"cmd\":\"frobnicate --all\"}",
          output: "Chunk ID: aebf5d\nWall time: 0.0512 seconds\nProcess exited with code 127\nOriginal token count: 13\nOutput:\n/bin/bash: line 1: frobnicate: command not found\n",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:42.000Z",
          tool_name: "exec_command",
          call_id: "tool-2",
          duration_ms: "50",
          success: "false",
          arguments: "{\"cmd\":\"echo hi > /etc/probe.txt\"}",
          output: "exec_command failed: CreateProcess { message: \"Codex(Sandbox(Denied { output: ExecToolCallOutput { exit_code: 1, stderr: StreamOutput { text: \\\"/bin/bash: line 1: /etc/probe.txt: Permission denied\\\\n\\\" } } }))\" }",
        },
        {
          "event.name": "codex.tool_result",
          "conversation.id": CONVERSATION_ID,
          "event.timestamp": "2026-08-26T13:46:43.000Z",
          tool_name: "exec_command",
          call_id: "tool-3",
          duration_ms: "50",
          success: "false",
          arguments: "{\"cmd\":\"echo hi > /etc/probe.txt\"}",
          output: "exec_command failed: CreateProcess { message: \"Codex(Sandbox(Denied { output: ExecToolCallOutput { exit_code: 1, stderr: StreamOutput { text: \\\"/bin/bash: line 1: /etc/probe.txt: Permission denied\\\\n\\\" } } }))\" }",
        },
      ]),
    );
    service.onRunEnd(RUN_ID, { status: "completed", output: "reported them" });

    const trace = store.get(RUN_ID);
    expect(trace?.status).toBe("completed");
    expect(trace?.recoveredErrorCount).toBe(3);
    // The exit code stated inside the denial envelope is carried through rather
    // than discarded, so the stored failure no longer claims a null exit.
    expect(trace?.failure?.kind).toBe("sandbox-denied");
    expect(trace?.failure?.exitCode).toBe(1);
  });

  it("marks a run whose evidence the output cap truncated", async () => {
    const { store, service } = await makeService();
    service.onRunStart(agent, { id: RUN_ID, prompt: "dump the logs" });
    service.onRunEnd(RUN_ID, {
      status: "failed",
      error: "output cap",
      failure: {
        layer: "platform",
        kind: "output-cap",
        retryability: "transient",
        title: "The Runtime exceeded its output budget",
        detail: "",
        remedy: "Raise CODEX_MAX_OUTPUT_BYTES.",
        exitCode: 1,
      },
    });
    expect(store.get(RUN_ID)?.evidenceComplete).toBe(false);
  });
});
