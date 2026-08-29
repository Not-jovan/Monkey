import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import { intentFileSchema } from "./intent-model.js";
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

function makeService(store: IntentStore, replies: string[]) {
  const { client, calls } = fakeClient(replies);
  const service = new IntentService({
    store,
    client,
    model: "intent-model",
    enabled: true,
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
    const view = service.view(AGENT);
    expect(view.intentId).toBeTruthy();
    expect(view.versions.at(-1)?.update).toBeUndefined();
  });

  it("uses the first message as the objective when there are no instructions", async () => {
    const { store } = await makeStore();
    const { service, calls } = makeService(store, []);
    service.observe(AGENT, "", {
      content: "Build a todo list web application",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    expect(service.state(AGENT).objective).toBe(
      "Build a todo list web application",
    );
    expect(calls).toHaveLength(0);
    expect(service.view(AGENT).versions.at(-1)?.update).toBeUndefined();
  });

  it("leaves the specification alone on NO_CHANGE", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":[]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Build the todo list UI.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    expect(service.state(AGENT).extended).toEqual([]);
    expect(service.view(AGENT).versions).toHaveLength(1);
  });

  it("appends a new version with logs when the classifier updates the spec", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Do not read from .env files.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
    const view = service.view(AGENT);
    expect(view.versions).toHaveLength(2);
    const latest = view.versions.at(-1);
    expect(latest?.id).toBe(view.intentId);
    expect(latest?.update?.logs).toContain("Do not read from .env files.");
    expect(latest?.update?.logs).toContain("prohibition");
    expect(latest?.update?.logs).toContain(
      "Added constraint: Do not read .env files.",
    );
    // The structured form the timeline reads, rather than the prose in logs.
    expect(latest?.update?.kind).toBe("classified");
    expect(latest?.update?.addedConstraints).toEqual([
      "Do not read .env files.",
    ]);
    expect(latest?.update?.message).toBe("Do not read from .env files.");
    // The trace id was already being handed to observe() and dropped; carrying
    // it is what lets the Playground mark the message that moved the spec.
    expect(latest?.update?.traceId).toBe("trace-1");
    expect(latest?.createdAt).toBeTruthy();
  });

  it("does not add the same constraint twice", async () => {
    const { store } = await makeStore();
    const reply =
      '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}';
    const { service } = makeService(store, [reply, reply]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Do not read .env.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    service.observe(AGENT, OBJECTIVE, {
      content: "Again: do not read .env.",
      messageId: "msg-2",
      traceId: "trace-2",
    });
    await service.idle();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
    expect(service.view(AGENT).versions).toHaveLength(2);
  });

  it("applies one human correction from grouped evidence exactly once", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, []);
    service.seed(AGENT, OBJECTIVE);
    const seedId = service.currentId(AGENT);

    const first = service.applyHumanCorrection(AGENT, {
      correction: "  Do not contact hosts outside the network whitelist.  ",
      traceId: "trace-2",
      sources: [
        { findingId: "finding-2", spanId: "span-7" },
        { findingId: "finding-3", spanId: "span-8" },
      ],
    });

    expect(first.created).toBeTruthy();
    expect(first.view.intent.extended).toEqual([
      "Do not contact hosts outside the network whitelist.",
    ]);
    const applied = first.view.versions.at(-1);
    expect(applied?.update?.kind).toBe("human-correction");
    expect(applied?.update?.traceId).toBe("trace-2");
    expect(applied?.update?.sources).toEqual([
      { findingId: "finding-2", spanId: "span-7" },
      { findingId: "finding-3", spanId: "span-8" },
    ]);

    const duplicate = service.applyHumanCorrection(AGENT, {
      correction: "A different correction must not replace the first one.",
      traceId: "trace-2",
      sources: [{ findingId: "finding-3", spanId: "span-8" }],
    });
    expect(duplicate.created).toBeNull();
    expect(service.view(AGENT).versions).toHaveLength(2);

    const reverted = service.revert(AGENT, seedId);
    expect(reverted.created).toBeTruthy();
    expect(reverted.view.intent.extended).toEqual([]);
  });

  it("removes persisted intent when an Agent is forgotten", async () => {
    const { store, directory } = await makeStore();
    const { service } = makeService(store, []);
    service.seed(AGENT, OBJECTIVE);
    await store.flush();

    service.forget(AGENT);
    await store.flush();

    const reopened = new IntentStore(path.join(directory, "intent"));
    await reopened.initialize();
    expect(reopened.list(AGENT)).toEqual([]);
  });

  it("does not resurrect a forgotten Agent when queued classification finishes", async () => {
    const { store, directory } = await makeStore();
    let markStarted!: () => void;
    let release!: (value: { content: string }) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Promise<{ content: string }>((resolve) => {
      release = resolve;
    });
    const client: ArkClient = {
      complete: async () => {
        markStarted();
        return response;
      },
    };
    const service = new IntentService({
      store,
      client,
      model: "intent-model",
      enabled: true,
    });
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "From now on, use HTML instead of Markdown.",
      messageId: "msg-delete",
      traceId: "trace-delete",
    });
    await started;

    service.forget(AGENT);
    release({
      content:
        '{"classification":"INTENT_UPDATE","reason":"rule","extendedIntent":["Use HTML, not Markdown."]}',
    });
    await service.idle();
    await store.flush();

    expect(service.view(AGENT).versions).toEqual([]);
    const reopened = new IntentStore(path.join(directory, "intent"));
    await reopened.initialize();
    expect(reopened.list(AGENT)).toEqual([]);
  });

  it("replaces the objective on a full pivot and keeps the previous version", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"pivot","extendedIntent":[],"objective":"Build a calendar application"}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    const seedId = service.currentId(AGENT);
    service.observe(AGENT, OBJECTIVE, {
      content: "Forget the todo app. I want a calendar.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    expect(service.state(AGENT).objective).toBe("Build a calendar application");
    const view = service.view(AGENT);
    expect(view.versions.find((entry) => entry.id === seedId)?.objective).toBe(
      OBJECTIVE,
    );
    const latest = view.versions.at(-1);
    expect(latest?.update?.logs).toContain(
      "Objective changed from " + OBJECTIVE + " to Build a calendar application",
    );
    expect(latest?.update?.previousObjective).toBe(OBJECTIVE);
  });

  it("never throws when the classifier gives up", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, ["bad", "bad", "bad"]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Do not read .env.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await expect(service.idle()).resolves.toBeUndefined();
    expect(service.state(AGENT).extended).toEqual([]);
  });

  it("persists versions in insertion order across a restart", async () => {
    const { store, directory } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"rule","extendedIntent":["Use TypeScript everywhere."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    const seedId = service.currentId(AGENT);
    service.observe(AGENT, OBJECTIVE, {
      content: "All new code must be TypeScript.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    const updateId = service.currentId(AGENT);
    await store.flush();

    const onDisk = intentFileSchema.parse(
      JSON.parse(
        await readFile(path.join(directory, "intent", AGENT + ".json"), "utf8"),
      ),
    );
    expect(Object.keys(onDisk)).toEqual([seedId, updateId]);
    expect(onDisk[seedId]?.update).toBeUndefined();
    expect(onDisk[updateId]?.extended).toEqual(["Use TypeScript everywhere."]);

    const reopened = new IntentStore(path.join(directory, "intent"));
    await reopened.initialize();
    const loaded = reopened.list(AGENT);
    expect(loaded).toHaveLength(2);
    expect(reopened.latest(AGENT)?.intentId).toBe(updateId);
    expect(reopened.latest(AGENT)?.version.extended).toEqual([
      "Use TypeScript everywhere.",
    ]);
    expect(reopened.latest(AGENT)?.version.objective).toBe(OBJECTIVE);
    expect(loaded.map((entry) => entry.id)).toEqual([seedId, updateId]);
  });

  // Revert appends rather than rewinding. Anything else would strand every
  // audit that pinned the version being reverted away from.
  it("reverts by appending a version that restores an earlier one", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"rule","extendedIntent":["Use HTML, not Markdown."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    const seedId = service.currentId(AGENT);
    service.observe(AGENT, OBJECTIVE, {
      content: "From now on, use HTML instead of Markdown.",
      messageId: "msg-1",
      traceId: "trace-1",
    });
    await service.idle();
    const updatedId = service.currentId(AGENT);
    expect(service.state(AGENT).extended).toEqual(["Use HTML, not Markdown."]);

    const { created, view } = service.revert(AGENT, seedId);
    expect(created).toBeTruthy();
    expect(view.versions).toHaveLength(3);
    expect(service.state(AGENT).extended).toEqual([]);

    const reverted = view.versions.at(-1);
    expect(reverted?.update?.kind).toBe("revert");
    expect(reverted?.update?.revertedFrom).toBe(seedId);

    // Both superseded versions stay readable, which is what keeps an older
    // trace's "spec in force" resolvable.
    expect(view.versions.find((entry) => entry.id === seedId)).toBeTruthy();
    expect(
      view.versions.find((entry) => entry.id === updatedId)?.extended,
    ).toEqual(["Use HTML, not Markdown."]);
  });

  it("refuses to revert to the version already in force, or to an unknown one", () => {
    return makeStore().then(async ({ store }) => {
      const { service } = makeService(store, []);
      service.seed(AGENT, OBJECTIVE);
      expect(service.revert(AGENT, service.currentId(AGENT)).created).toBeNull();
      expect(service.revert(AGENT, "not-a-version").created).toBeNull();
    });
  });
});
