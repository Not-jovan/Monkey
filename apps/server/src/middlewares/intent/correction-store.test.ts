import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IntentCorrectionStore, type IntentCorrection } from "./correction-store.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "corrections-test-"));
  directories.push(root);
  const directory = path.join(root, "intent-corrections");
  const store = new IntentCorrectionStore(directory);
  await store.initialize();
  return { store, directory };
}

function correction(overrides: Partial<IntentCorrection> = {}): IntentCorrection {
  return {
    id: "correction-1",
    agentId: "agent-1",
    traceId: "trace-1",
    findingIds: ["finding-1"],
    correction: "Do not read .env files.",
    instructionsBefore: "Build a todo list.",
    createdAt: "2026-08-30T00:00:00.000Z",
    revertedAt: null,
    ...overrides,
  };
}

describe("IntentCorrectionStore", () => {
  it("keeps corrections oldest first, per agent", async () => {
    const { store } = await makeStore();

    await store.append(correction({ id: "a", createdAt: "2026-08-30T00:00:00.000Z" }));
    await store.append(correction({ id: "b", createdAt: "2026-08-30T01:00:00.000Z" }));
    await store.append(correction({ id: "c", agentId: "agent-2" }));

    expect(store.list("agent-1").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(store.list("agent-2").map((entry) => entry.id)).toEqual(["c"]);
    expect(store.list("agent-unknown")).toEqual([]);
  });

  // The write is awaited, not queued behind the response. A correction whose
  // record did not survive the request is a correction nobody can explain.
  it("has written the file by the time append resolves", async () => {
    const { store, directory } = await makeStore();

    await store.append(correction({ id: "a" }));

    const raw = await readFile(path.join(directory, "agent-1.json"), "utf8");
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it("reads its records back after a restart", async () => {
    const { store, directory } = await makeStore();
    await store.append(correction({ id: "a" }));
    await store.flush();

    const reopened = new IntentCorrectionStore(directory);
    await reopened.initialize();

    expect(reopened.list("agent-1").map((entry) => entry.id)).toEqual(["a"]);
    expect(reopened.get("agent-1", "a")?.correction).toBe("Do not read .env files.");
    expect(reopened.get("agent-1", "missing")).toBeNull();
  });

  // Undo restores `instructionsBefore`, which describes the spec as it was
  // immediately before that one edit. Offering an older correction would throw
  // away every correction made after it without saying so.
  it("offers only the newest correction still in force for undo", async () => {
    const { store } = await makeStore();
    await store.append(correction({ id: "a" }));
    await store.append(correction({ id: "b" }));

    expect(store.latestActive("agent-1")?.id).toBe("b");

    await store.markReverted("agent-1", "b", "2026-08-30T02:00:00.000Z");

    expect(store.latestActive("agent-1")?.id).toBe("a");
  });

  it("keeps an undone correction on the record rather than deleting it", async () => {
    const { store } = await makeStore();
    await store.append(correction({ id: "a" }));

    await store.markReverted("agent-1", "a", "2026-08-30T02:00:00.000Z");

    expect(store.list("agent-1")).toHaveLength(1);
    expect(store.get("agent-1", "a")?.revertedAt).toBe("2026-08-30T02:00:00.000Z");
    expect(store.latestActive("agent-1")).toBeNull();
    expect(await store.markReverted("agent-1", "missing", "now")).toBeNull();
  });

  // An unreadable file must not take the rest of the agents down with it, and
  // must not pass silently either.
  it("reports a corrupt file and keeps every other agent readable", async () => {
    const { store, directory } = await makeStore();
    await store.append(correction({ id: "a" }));
    await store.flush();
    await writeFile(path.join(directory, "agent-broken.json"), "{not json", "utf8");

    const messages: string[] = [];
    const reopened = new IntentCorrectionStore(directory, (message) =>
      messages.push(message),
    );
    await reopened.initialize();

    expect(reopened.list("agent-1").map((entry) => entry.id)).toEqual(["a"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("agent-broken");
  });
});
