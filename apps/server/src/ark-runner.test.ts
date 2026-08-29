import { describe, expect, it } from "vitest";
import { ArkApiError, type ArkClient } from "./ark-client.js";
import { ArkRunner } from "./ark-runner.js";
import type { AppConfig } from "./config.js";

const config = { arkModel: "default-model" } as AppConfig;

function client(
  complete: ArkClient["complete"],
): ArkClient {
  return { complete };
}

const request = {
  agentId: "agent-1",
  workspacePath: "/data/agent-runs/agent-1/chat-1",
  prompt: "judge this step",
  threadId: null,
};

describe("ArkRunner", () => {
  it("reports the completion as a runner result, tokens and all", async () => {
    const runner = new ArkRunner(
      client(async () => ({
        content: '{"ok":true}',
        usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 7 },
        model: "served-model",
      })),
      config,
      4_096,
    );

    const models: string[] = [];
    const result = await runner.run({
      ...request,
      system: "you are an auditor",
      model: "asked-model",
      onModel: (model) => models.push(model),
    });

    expect(result.output).toBe('{"ok":true}');
    expect(result.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 4,
      outputTokens: 7,
    });
    // What served the request, not what was asked for: Ark resolves an endpoint
    // id to a concrete model.
    expect(result.model).toBe("served-model");
    expect(models).toEqual(["served-model"]);
    // A completion is one exchange, so there is no conversation to correlate on.
    expect(result.threadId).toBeNull();
  });

  it("passes the system prompt and model through rather than inventing them", async () => {
    const seen: { model: string; system: string; user: string }[] = [];
    const runner = new ArkRunner(
      client(async (input) => {
        seen.push({ model: input.model, system: input.system, user: input.user });
        return { content: "{}", usage: null, model: null };
      }),
      config,
      4_096,
    );

    await runner.run({ ...request, system: "sys", model: "sec-model" });

    expect(seen).toEqual([
      { model: "sec-model", system: "sys", user: "judge this step" },
    ]);
  });

  // The auditor's fallback and its memo of unactivated models both branch on
  // the provider's own error type. Wrapping it here would silently turn a
  // permanent failure into a transient one, and the fallback would stop working.
  it("lets the provider error through unwrapped", async () => {
    const runner = new ArkRunner(
      client(async () => {
        throw new ArkApiError("not activated", "ModelNotOpen", 404);
      }),
      config,
      4_096,
    );

    await expect(runner.run({ ...request, model: "m" })).rejects.toBeInstanceOf(
      ArkApiError,
    );
  });

  // Unlike a process runner, which rejects a second run for the same agent
  // because one workspace cannot host two CLI processes. This one has no
  // workspace, and the auditor fires seven checks for a single step at once.
  it("runs concurrently for one agent", async () => {
    let open = 0;
    let peak = 0;
    const runner = new ArkRunner(
      client(async () => {
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return { content: "{}", usage: null, model: null };
      }),
      config,
      4_096,
    );

    await Promise.all([
      runner.run({ ...request, model: "m" }),
      runner.run({ ...request, model: "m" }),
      runner.run({ ...request, model: "m" }),
    ]);

    expect(peak).toBe(3);
  });

  it("falls back to the configured model when a caller names none", async () => {
    const seen: string[] = [];
    const runner = new ArkRunner(
      client(async (input) => {
        seen.push(input.model);
        return { content: "{}", usage: null, model: null };
      }),
      config,
      4_096,
    );

    await runner.run(request);

    expect(seen).toEqual(["default-model"]);
  });

  it("says so rather than guessing when no model is available at all", async () => {
    const runner = new ArkRunner(
      client(async () => ({ content: "{}", usage: null, model: null })),
      { arkModel: "" } as AppConfig,
      4_096,
    );

    await expect(runner.run(request)).rejects.toThrow("needs a model");
  });

  it("cancels what is in flight for one agent", async () => {
    const runner = new ArkRunner(
      client(async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (signal?.aborted) throw new Error("aborted");
        return { content: "{}", usage: null, model: null };
      }),
      config,
      4_096,
    );

    const running = runner.run({ ...request, model: "m" });
    expect(await runner.cancel("agent-1")).toBe(true);
    await expect(running).rejects.toThrow("aborted");
    // Nothing left to cancel once it has settled.
    expect(await runner.cancel("agent-1")).toBe(false);
  });
});
