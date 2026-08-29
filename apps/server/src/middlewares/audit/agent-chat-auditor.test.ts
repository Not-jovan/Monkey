import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentChatAuditor, type ChatAuditorWork } from "./agent-chat-auditor.js";

function auditor(work: Partial<ChatAuditorWork> = {}) {
  const calls: string[] = [];
  const chat = new AgentChatAuditor("agent-1", "chat-1", "/data/agent-runs", {
    runStepAudit: async (_chat, spanId) => {
      calls.push("step:" + spanId);
    },
    runAll: async () => {
      calls.push("all");
    },
    runMetaAudit: async () => {
      calls.push("meta");
    },
    ...work,
  });
  return { chat, calls };
}

describe("AgentChatAuditor", () => {
  it("owns the memory folder its artifacts go to", () => {
    const { chat } = auditor();
    expect(chat.memoryFolderPath).toBe(
      path.join("/data/agent-runs", "agent-1", "chat-1"),
    );
    expect(chat.agentId).toBe("agent-1");
    expect(chat.chatId).toBe("chat-1");
  });

  it("routes its two entry points to the work it was given", async () => {
    const { chat, calls } = auditor();
    await chat.auditStep("span-1");
    await chat.auditAll();
    expect(calls).toEqual(["step:span-1", "all"]);
  });

  // The run-level checks read every step's record, so they must not start while
  // a step audit is still in flight. Being queued behind one is not enough:
  // batches run concurrently.
  it("holds the run-level pass until its step audits have finished", async () => {
    const { chat } = auditor();
    chat.openStep();
    chat.openStep();

    let released = false;
    const waiting = chat.awaitSteps().then(() => {
      released = true;
    });

    chat.closeStep();
    await Promise.resolve();
    expect(released).toBe(false);

    chat.closeStep();
    await waiting;
    expect(released).toBe(true);
  });

  it("resolves immediately when nothing is in flight", async () => {
    const { chat } = auditor();
    await expect(chat.awaitSteps()).resolves.toBeUndefined();
  });

  // Said once per chat: a long run would otherwise repeat "auditing stopped"
  // on every step past the budget.
  it("reports the step cap once", () => {
    const { chat } = auditor();
    expect(chat.reportCap()).toBe(true);
    expect(chat.reportCap()).toBe(false);
    expect(chat.reportCap()).toBe(false);
  });

  // Auditing the auditor twice at once would judge a half-written record.
  it("refuses a second meta-audit while the first is running", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const { chat } = auditor({
      runMetaAudit: async () => {
        calls.push("meta");
        await pending;
      },
    });

    const first = chat.auditAuditor();
    expect(await chat.auditAuditor()).toBe("in-flight");
    // The refused trigger did no work; only the first one ran.
    expect(calls).toEqual(["meta"]);
    release();
    expect(await first).toBe("done");
    // And the guard lifts once it is finished.
    expect(await chat.auditAuditor()).toBe("done");
    expect(calls).toEqual(["meta", "meta"]);
  });

  it("lifts the meta-audit guard when the work throws", async () => {
    const { chat } = auditor({
      runMetaAudit: async () => {
        throw new Error("boom");
      },
    });
    await expect(chat.auditAuditor()).rejects.toThrow("boom");
    // Not wedged: a failed meta-audit must not block every later one.
    await expect(chat.auditAuditor()).rejects.toThrow("boom");
  });
});
