import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import { IntentService } from "./intent-service.js";
import { IntentStore } from "./intent-store.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fakeClient(replies: string[]) {
  const calls: { user: string }[] = [];
  const client: ArkClient = {
    complete: async ({ user }) => {
      calls.push({ user });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no reply queued");
      if (reply === "THROW") throw new Error("model offline");
      return { content: reply };
    },
  };
  return { client, calls };
}

async function makeStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "intent-"));
  const store = new IntentStore(path.join(directory, "intent"));
  await store.initialize();
  cleanups.push(async () => {
    await store.flush();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return { store, directory };
}

const AGENT = "agent-1";
const OBJECTIVE = "Build a todo list web application";

function makeService(
  store: IntentStore,
  replies: string[],
  options: { requireConfirmation?: boolean } = {},
) {
  const { client, calls } = fakeClient(replies);
  const service = new IntentService({
    store,
    client,
    model: "intent-model",
    enabled: true,
    ...options,
  });
  return { service, calls };
}

describe("classifyIntent", () => {
  it("forces an empty extendedIntent on NO_CHANGE", async () => {
    const { client } = fakeClient([
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":["stray"]}',
    ]);
    const result = await classifyIntent(
      client,
      "m",
      { objective: OBJECTIVE, extended: [] },
      "Build the todo list UI.",
    );
    expect(result.classification?.classification).toBe("NO_CHANGE");
    expect(result.classification?.extendedIntent).toEqual([]);
    expect(result.attempts).toBe(1);
  });

  it("re-prompts with a correction and accepts a later valid reply", async () => {
    const { client, calls } = fakeClient([
      "not json at all",
      '{"classification":"INTENT_UPDATE","reason":"rule","extendedIntent":["Do not read .env files."]}',
    ]);
    const result = await classifyIntent(
      client,
      "m",
      { objective: OBJECTIVE, extended: [] },
      "Do not read from .env files.",
    );
    expect(result.attempts).toBe(2);
    expect(result.classification?.extendedIntent).toEqual([
      "Do not read .env files.",
    ]);
    expect(calls[1]?.user).toContain("Reply with JSON only");
  });

  it("gives up after three attempts rather than looping", async () => {
    const { client, calls } = fakeClient(["bad", "worse", "worst"]);
    const result = await classifyIntent(
      client,
      "m",
      { objective: OBJECTIVE, extended: [] },
      "anything",
    );
    expect(result.classification).toBeNull();
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(result.failure).not.toBeNull();
  });

  it("survives a model that throws", async () => {
    const { client } = fakeClient(["THROW", "THROW", "THROW"]);
    const result = await classifyIntent(
      client,
      "m",
      { objective: OBJECTIVE, extended: [] },
      "anything",
    );
    expect(result.classification).toBeNull();
    expect(result.failure).toContain("model offline");
  });

  it("shows the model the constraints already in force", async () => {
    const { client, calls } = fakeClient([
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":[]}',
    ]);
    await classifyIntent(
      client,
      "m",
      { objective: OBJECTIVE, extended: ["Do not read .env files."] },
      "Add tests for the todo API.",
    );
    expect(calls[0]?.user).toContain("Do not read .env files.");
    expect(calls[0]?.user).toContain(OBJECTIVE);
  });
});

describe("IntentService", () => {
  it("seeds the objective from the agent instructions", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, []);
    service.seed(AGENT, "  " + OBJECTIVE + "  ");
    expect(service.state(AGENT)).toEqual({
      objective: OBJECTIVE,
      extended: [],
    });
  });

  it("uses the first message as the objective when there are no instructions", async () => {
    const { store } = await makeStore();
    const { service, calls } = makeService(store, []);
    service.observe(AGENT, "", "Build a todo list web application");
    await service.idle();
    expect(service.state(AGENT).objective).toBe(
      "Build a todo list web application",
    );
    // The first message is the intent; there is nothing to classify it against.
    expect(calls).toHaveLength(0);
  });

  it("leaves the specification alone on NO_CHANGE", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":[]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Build the todo list UI.");
    await service.idle();
    expect(service.state(AGENT).extended).toEqual([]);
    expect(service.record(AGENT)?.history).toEqual([]);
  });

  it("appends a new constraint and records why it exists", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Do not read from .env files.");
    await service.idle();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
    const [update] = service.record(AGENT)?.history ?? [];
    expect(update?.status).toBe("applied");
    expect(update?.message).toBe("Do not read from .env files.");
    expect(update?.reason).toBe("prohibition");
  });

  it("does not add the same constraint twice", async () => {
    const { store } = await makeStore();
    const reply =
      '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}';
    const { service } = makeService(store, [reply, reply]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Do not read .env.");
    await service.idle();
    service.observe(AGENT, OBJECTIVE, "Again: do not read .env.");
    await service.idle();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
    expect(service.record(AGENT)?.history).toHaveLength(1);
  });

  it("replaces the objective on a full pivot and keeps the old one on record", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"pivot","extendedIntent":[],"objective":"Build a calendar application"}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Forget the todo app. I want a calendar.");
    await service.idle();
    expect(service.state(AGENT).objective).toBe("Build a calendar application");
    const [update] = service.record(AGENT)?.history ?? [];
    expect(update?.objectiveBefore).toBe(OBJECTIVE);
    expect(update?.objectiveAfter).toBe("Build a calendar application");
  });

  it("holds an update as pending when confirmation is required", async () => {
    const { store } = await makeStore();
    const { service } = makeService(
      store,
      [
        '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}',
      ],
      { requireConfirmation: true },
    );
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Do not read .env.");
    await service.idle();
    expect(service.state(AGENT).extended).toEqual([]);
    expect(service.record(AGENT)?.history[0]?.status).toBe("pending");
  });

  it("never throws when the classifier gives up", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, ["bad", "bad", "bad"]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Do not read .env.");
    await expect(service.idle()).resolves.toBeUndefined();
    expect(service.state(AGENT).extended).toEqual([]);
  });

  it("persists the specification across a restart", async () => {
    const { store, directory } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"rule","extendedIntent":["Use TypeScript everywhere."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "All new code must be TypeScript.");
    await service.idle();
    await store.flush();

    const reopened = new IntentStore(path.join(directory, "intent"));
    await reopened.initialize();
    expect(reopened.get(AGENT)?.extended).toEqual([
      "Use TypeScript everywhere.",
    ]);
    expect(reopened.get(AGENT)?.objective).toBe(OBJECTIVE);
  });
  it("applies a pending update only once the user confirms it", async () => {
    const { store } = await makeStore();
    const { service } = makeService(
      store,
      [
        '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}',
      ],
      { requireConfirmation: true },
    );
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Do not read .env.");
    await service.idle();

    const [proposed] = service.pending(AGENT);
    expect(proposed).toBeDefined();
    expect(service.state(AGENT).extended).toEqual([]);

    service.resolve(AGENT, proposed!.id, "confirm");
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
    expect(service.pending(AGENT)).toEqual([]);
    expect(service.record(AGENT)?.history[0]?.status).toBe("applied");
  });

  it("keeps a rejected update on record without applying it", async () => {
    const { store } = await makeStore();
    const { service } = makeService(
      store,
      [
        '{"classification":"INTENT_UPDATE","reason":"pivot","extendedIntent":[],"objective":"Build a calendar application"}',
      ],
      { requireConfirmation: true },
    );
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Actually, build a calendar.");
    await service.idle();

    const [proposed] = service.pending(AGENT);
    service.resolve(AGENT, proposed!.id, "reject");
    expect(service.state(AGENT).objective).toBe(OBJECTIVE);
    expect(service.pending(AGENT)).toEqual([]);
    expect(service.record(AGENT)?.history[0]?.status).toBe("rejected");
  });

  it("refuses to resolve an update that is not pending", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"rule","extendedIntent":["Do not read .env files."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, "Do not read .env.");
    await service.idle();

    const [applied] = service.record(AGENT)?.history ?? [];
    expect(service.resolve(AGENT, applied!.id, "reject")).toBeNull();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
  });
});
