import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArkClient } from "../audits/ark-client.js";
import { classifyIntent } from "./intent-classifier.js";
import { intentFileSchema } from "./intent-model.js";
import { IntentService, type ClassifyFailure } from "./intent-service.js";
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
  const dropped: ClassifyFailure[] = [];
  const service = new IntentService({
    store,
    client,
    model: "intent-model",
    enabled: true,
    onClassifyFailed: (failure) => dropped.push(failure),
  });
  return { service, calls, dropped };
}

describe("classifyIntent", () => {
  it("forces an empty extendedIntent on NO_CHANGE", async () => {
    const { client } = fakeClient([
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":["stray"]}',
    ]);
    const result = await classifyIntent(
      client,
      "m",
      { instructions: "", objective: OBJECTIVE, extended: [] },
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
      { instructions: "", objective: OBJECTIVE, extended: [] },
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
      { instructions: "", objective: OBJECTIVE, extended: [] },
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
      { instructions: "", objective: OBJECTIVE, extended: [] },
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
      { instructions: "", objective: OBJECTIVE, extended: ["Do not read .env files."] },
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
    // Instructions are the source of truth, so seeding records them as both the
    // base and the working objective. The two agreeing is what "in sync" means.
    expect(service.state(AGENT)).toEqual({
      instructions: OBJECTIVE,
      objective: OBJECTIVE,
      extended: [],
    });
    const view = service.view(AGENT);
    expect(view.intentId).toBeTruthy();
    expect(view.versions.at(-1)?.update).toBeUndefined();
    expect(view.diverged).toBe(false);
  });

  describe("instructions as the source of truth", () => {
    const REVISED = "Build a todo list web application with a REST API";

    it("moves the objective when the instructions are edited", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, []);
      service.seed(AGENT, OBJECTIVE);

      service.syncInstructions(AGENT, REVISED);

      // The whole point: editing instructions used to leave the auditor judging
      // against the spec the agent had already stopped following.
      expect(service.state(AGENT)).toEqual({
        instructions: REVISED,
        objective: REVISED,
        extended: [],
      });
      const latest = service.view(AGENT).versions.at(-1);
      expect(latest?.update?.kind).toBe("instructions");
      expect(latest?.update?.logs[0]).toContain(REVISED);
    });

    it("appends nothing when the instructions did not change", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, []);
      service.seed(AGENT, OBJECTIVE);
      const before = service.view(AGENT).versions.length;

      // PATCH fires on any field, so renaming an agent reaches this path.
      service.syncInstructions(AGENT, OBJECTIVE);
      service.syncInstructions(AGENT, "  " + OBJECTIVE + "  ");

      expect(service.view(AGENT).versions).toHaveLength(before);
    });

    it("keeps constraints gathered from the conversation across an edit", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, [
        '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}',
      ]);
      service.seed(AGENT, OBJECTIVE);
      service.observe(AGENT, OBJECTIVE, {
        content: "Never read .env files.",
        traceId: "trace-1",
      });
      await service.idle();

      service.syncInstructions(AGENT, REVISED);

      // The user stated this separately and never took it back; an unrelated
      // instructions edit must not quietly drop it.
      expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
      expect(service.state(AGENT).objective).toBe(REVISED);
    });

    it("leaves a deliberate divergence alone when instructions are edited", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, [
        '{"classification":"INTENT_UPDATE","reason":"pivot","extendedIntent":[],"objective":"Build a calendar app"}',
      ]);
      service.seed(AGENT, OBJECTIVE);
      service.observe(AGENT, OBJECTIVE, {
        content: "Forget the todo app, build a calendar instead.",
        traceId: "trace-1",
      });
      await service.idle();
      expect(service.view(AGENT).diverged).toBe(true);

      service.syncInstructions(AGENT, REVISED);

      // Overwriting here would silently discard a pivot the user made and has
      // not yet adopted. The instructions move; the objective stays put.
      expect(service.state(AGENT)).toEqual({
        instructions: REVISED,
        objective: "Build a calendar app",
        extended: [],
      });
      expect(service.view(AGENT).diverged).toBe(true);
    });

    it("reports a conversational pivot as diverged without touching instructions", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, [
        '{"classification":"INTENT_UPDATE","reason":"pivot","extendedIntent":[],"objective":"Build a calendar app"}',
      ]);
      service.seed(AGENT, OBJECTIVE);
      service.observe(AGENT, OBJECTIVE, {
        content: "Forget the todo app, build a calendar instead.",
        traceId: "trace-1",
      });
      await service.idle();

      // A classification never rewrites user-authored configuration; it records
      // the gap and waits to be adopted.
      expect(service.state(AGENT).instructions).toBe(OBJECTIVE);
      expect(service.state(AGENT).objective).toBe("Build a calendar app");
      expect(service.pendingAdoption(AGENT)).toBe("Build a calendar app");
    });

    it("has nothing to adopt while the objective tracks the instructions", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, []);
      service.seed(AGENT, OBJECTIVE);
      expect(service.pendingAdoption(AGENT)).toBeNull();
    });

    it("does not let a revert claim the agent was told something it was not", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, []);
      service.seed(AGENT, OBJECTIVE);
      const original = service.view(AGENT).intentId!;

      // The operator edits the instructions in agent settings. AGENTS.md now
      // says REVISED, and that is what the agent reads from here on.
      service.syncInstructions(AGENT, REVISED);

      service.revert(AGENT, original);

      // A revert restores the goal, not the agent's configuration — this cannot
      // rewrite AGENTS.md, so recording the old instructions would have the
      // record assert something false about what the agent is following.
      const state = service.state(AGENT);
      expect(state.instructions).toBe(REVISED);
      expect(state.objective).toBe(OBJECTIVE);
      // And because the two now genuinely disagree, it is reported rather than
      // hidden behind a stale mirror that made them look identical.
      expect(service.view(AGENT).diverged).toBe(true);
      expect(service.pendingAdoption(AGENT)).toBe(OBJECTIVE);
    });

    it("keeps the objective when the instructions are cleared", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, []);
      service.seed(AGENT, OBJECTIVE);

      service.syncInstructions(AGENT, "");

      // Clearing removes the base, not the goal. Letting the objective follow
      // to empty left the auditor with no spec and a silent fallback to
      // whatever that run's prompt happened to say.
      expect(service.state(AGENT).objective).toBe(OBJECTIVE);
      expect(service.state(AGENT).instructions).toBe("");
      // Nothing to be out of step with, so this is not a divergence.
      expect(service.view(AGENT).diverged).toBe(false);
      expect(service.view(AGENT).versions.at(-1)?.update?.logs[0]).toContain(
        "Instructions cleared",
      );
    });

    it("reads a version written before instructions were tracked as in sync", async () => {
      const { store } = await makeStore();
      const { service } = makeService(store, []);
      // What an intent file on disk looks like from before this field existed.
      store.append(AGENT, {
        instructions: "",
        objective: OBJECTIVE,
        extended: ["Do not read .env files."],
      });
      expect(service.view(AGENT).diverged).toBe(false);
      expect(service.pendingAdoption(AGENT)).toBeNull();
    });
  });

  it("uses the first message as the objective when there are no instructions", async () => {
    const { store } = await makeStore();
    const { service, calls } = makeService(store, []);
    service.observe(AGENT, "", {
      content: "Build a todo list web application",
      traceId: "trace-1",
    });
    await service.idle();
    expect(service.state(AGENT).objective).toBe(
      "Build a todo list web application",
    );
    expect(calls).toHaveLength(0);
    expect(service.view(AGENT).versions.at(-1)?.update).toBeUndefined();
  });

  it("lifts a constraint the user takes back instead of contradicting it", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"prohibition","extendedIntent":["Do not read .env files."]}',
      '{"classification":"INTENT_UPDATE","reason":"relaxation","extendedIntent":[],"removedIntent":["Do not read .env files."]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Do not read from .env files.",
      traceId: "trace-1",
    });
    await service.idle();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);

    service.observe(AGENT, OBJECTIVE, {
      content: "Actually, you can read .env now.",
      traceId: "trace-2",
    });
    await service.idle();

    // The rule is gone, not sitting next to its own opposite. A spec holding
    // both a prohibition and its permission cannot be enforced by anything.
    expect(service.state(AGENT).extended).toEqual([]);
    const latest = service.view(AGENT).versions.at(-1);
    expect(latest?.update?.removedConstraints).toEqual([
      "Do not read .env files.",
    ]);
    expect(latest?.update?.logs).toContain(
      "Removed constraint: Do not read .env files.",
    );
  });

  it("matches a lifted constraint through punctuation and case drift", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"INTENT_UPDATE","reason":"relaxation","extendedIntent":[],"removedIntent":["do not read .env files"]}',
    ]);
    store.seed(AGENT, OBJECTIVE);
    store.append(AGENT, {
      instructions: "",
      objective: OBJECTIVE,
      extended: ["Do not read .env files."],
    });
    service.observe(AGENT, OBJECTIVE, {
      content: "You can read .env now.",
      traceId: "trace-1",
    });
    await service.idle();
    // Round-tripping the text through a model must not let a capital letter or
    // a missing full stop leave the rule standing.
    expect(service.state(AGENT).extended).toEqual([]);
  });

  it("reports a message it could not classify instead of dropping it", async () => {
    const { store } = await makeStore();
    const { service, dropped } = makeService(store, ["bad", "worse", "worst"]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "From now on, never touch .env files.",
      traceId: "trace-1",
    });
    await service.idle();

    // The spec is genuinely unchanged — that is the failure, not the report.
    expect(service.state(AGENT).extended).toEqual([]);
    // But something has to say so, or the user believes a rule is in force
    // that the auditor has never heard of.
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.agentId).toBe(AGENT);
    expect(dropped[0]?.traceId).toBe("trace-1");
    expect(dropped[0]?.attempts).toBe(3);
    expect(dropped[0]?.failure).toBeTruthy();
  });

  it("stays quiet when the classifier succeeds", async () => {
    const { store } = await makeStore();
    const { service, dropped } = makeService(store, [
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":[]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Build the todo list UI.",
      traceId: "trace-1",
    });
    await service.idle();
    expect(dropped).toEqual([]);
  });

  it("leaves the specification alone on NO_CHANGE", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, [
      '{"classification":"NO_CHANGE","reason":"work","extendedIntent":[]}',
    ]);
    service.seed(AGENT, OBJECTIVE);
    service.observe(AGENT, OBJECTIVE, {
      content: "Build the todo list UI.",
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
      traceId: "trace-1",
    });
    await service.idle();
    service.observe(AGENT, OBJECTIVE, {
      content: "Again: do not read .env.",
      traceId: "trace-2",
    });
    await service.idle();
    expect(service.state(AGENT).extended).toEqual(["Do not read .env files."]);
    expect(service.view(AGENT).versions).toHaveLength(2);
  });

  it("applies a human correction with evidence provenance exactly once", async () => {
    const { store } = await makeStore();
    const { service } = makeService(store, []);
    service.seed(AGENT, OBJECTIVE);

    const first = service.applyHumanCorrection(AGENT, {
      correction: "  Do not contact hosts outside the network whitelist.  ",
      traceId: "trace-2",
      findingId: "finding-2",
      spanId: "span-7",
    });

    expect(first.created).toBeTruthy();
    expect(first.view.intent.extended).toEqual([
      "Do not contact hosts outside the network whitelist.",
    ]);
    const applied = first.view.versions.at(-1);
    expect(applied?.update?.kind).toBe("human-correction");
    expect(applied?.update?.traceId).toBe("trace-2");
    expect(applied?.update?.sourceFindingId).toBe("finding-2");
    expect(applied?.update?.sourceSpanId).toBe("span-7");

    const duplicate = service.applyHumanCorrection(AGENT, {
      correction: "A different correction must not replace the first one.",
      traceId: "trace-2",
      findingId: "finding-2",
      spanId: "span-7",
    });
    expect(duplicate.created).toBeNull();
    expect(service.view(AGENT).versions).toHaveLength(2);
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

describe("IntentStore persistence", () => {
  it("reports a write that did not land instead of swallowing it", async () => {
    const failures: { message: string; error?: unknown }[] = [];
    // A path whose parent is a file, not a directory: writeFile fails with
    // ENOTDIR every time, standing in for a full disk or a permissions problem.
    const directory = await mkdtemp(path.join(tmpdir(), "intent-badpath-"));
    const blocker = path.join(directory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const store = new IntentStore(path.join(blocker, "intent"), (message, error) =>
      failures.push({ message, error }),
    );
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    });

    store.seed(AGENT, OBJECTIVE, OBJECTIVE);
    await store.flush();

    // In memory the spec looks saved. Without this report, the divergence
    // between memory and disk is only discovered after a restart, by which
    // point the constraint is gone and nothing ever said so.
    expect(store.latest(AGENT)?.version.objective).toBe(OBJECTIVE);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain(AGENT);
    expect(failures[0]?.error).toBeInstanceOf(Error);
  });
});
