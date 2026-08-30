import { describe, expect, it } from "vitest";
import { ArkAbortError, ArkApiError, createArkClient } from "./ark-client.js";

const timeoutMs = 80;

function client(fetchImpl: typeof fetch) {
  return createArkClient(
    { arkBaseUrl: "https://ark.test", arkApiKey: "k" },
    timeoutMs,
    fetchImpl,
  );
}

const ask = {
  model: "flash",
  system: "sys",
  user: "user",
};

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

function hangUntilAbort(signal: AbortSignal | undefined) {
  return new Promise<Response>((_resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hangingStream(signal: AbortSignal | undefined, prelude?: string) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prelude) controller.enqueue(encoder.encode(prelude));
      const onAbort = () => {
        try {
          controller.error(abortError());
        } catch {
          // already closed or errored
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    },
  });
}

function sseEvent(payload: unknown) {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

describe("createArkClient", () => {
  it("reads a JSON completion without asking the provider to stream", async () => {
    let body: unknown = null;
    const ark = client(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "json-1",
          model: "served",
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "hdr-1",
          },
        },
      );
    });

    const result = await ark.complete(ask);

    expect(body).toMatchObject({ model: "flash" });
    expect(body).not.toHaveProperty("stream");
    expect(result.content).toBe('{"ok":true}');
    expect(result.model).toBe("served");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(result.timing.abortPhase).toBeNull();
    expect(result.timing.requestId).toBe("hdr-1");
    expect(result.timing.headersMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.ttftMs).not.toBeNull();
    expect(result.timing.chunkCount).toBe(1);
    expect(result.timing.promptBytes).toBe(
      new TextEncoder().encode("sys").length +
        new TextEncoder().encode("user").length,
    );
  });

  it("uses reasoning_content when the answer field is empty", async () => {
    const ark = client(async () =>
      Response.json({
        id: "json-2",
        model: "served",
        choices: [
          {
            message: {
              content: "",
              reasoning_content: 'thinking...\n{"ok":true}',
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 40 },
      }),
    );

    const result = await ark.complete(ask);

    expect(result.content).toBe('thinking...\n{"ok":true}');
    expect(result.timing.ttftMs).not.toBeNull();
  });

  it("still assembles an SSE body if the provider streams anyway", async () => {
    const ark = client(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              sseEvent({
                id: "chat-1",
                model: "served",
                choices: [{ delta: { content: '{"ok":' } }],
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(
              sseEvent({
                choices: [{ delta: { content: "true}" } }],
                usage: { prompt_tokens: 9, completion_tokens: 4 },
              }),
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "hdr-1",
        },
      });
    });

    const result = await ark.complete(ask);

    expect(result.content).toBe('{"ok":true}');
    expect(result.model).toBe("served");
    expect(result.timing.chunkCount).toBeGreaterThanOrEqual(2);
  });

  it("names a timeout that never got headers", async () => {
    const ark = client(async (_url, init) => hangUntilAbort(init?.signal ?? undefined));

    try {
      await ark.complete(ask);
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(ArkAbortError);
      if (!(error instanceof ArkAbortError)) return;
      expect(error.kind).toBe("timeout");
      expect(error.summary).toBe(
        "Audit model timed out after 0.08s waiting for headers",
      );
      expect(error.message).toContain("(1 in flight)");
      expect(error.timing.abortPhase).toBe("waiting_for_headers");
      expect(error.timing.headersMs).toBeNull();
    }
  });

  it("names a timeout that got headers and nothing else", async () => {
    const ark = client(async (_url, init) => {
      return new Response(hangingStream(init?.signal ?? undefined), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-hang",
        },
      });
    });

    try {
      await ark.complete(ask);
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(ArkAbortError);
      if (!(error instanceof ArkAbortError)) return;
      expect(error.summary).toBe(
        "Audit model timed out after 0.08s; headers received, no tokens",
      );
      expect(error.message).toContain("headers at");
      expect(error.timing.abortPhase).toBe("waiting_for_first_token");
      expect(error.timing.headersMs).not.toBeNull();
      expect(error.timing.requestId).toBe("req-hang");
      expect(error.timing.chunkCount).toBe(0);
    }
  });

  it("names a timeout that started streaming an answer", async () => {
    const ark = client(async (_url, init) => {
      return new Response(
        hangingStream(
          init?.signal ?? undefined,
          sseEvent({ choices: [{ delta: { content: '{"ok":' } }] }),
        ),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });

    try {
      await ark.complete(ask);
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(ArkAbortError);
      if (!(error instanceof ArkAbortError)) return;
      expect(error.summary).toBe(
        "Audit model timed out after 0.08s while streaming",
      );
      expect(error.content).toBe('{"ok":');
      expect(error.timing.abortPhase).toBe("streaming");
      expect(error.timing.ttftMs).not.toBeNull();
      expect(error.timing.chunkCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("counts in-flight calls at send time, including this one", async () => {
    let entered = 0;
    let firstEntered: (() => void) | undefined;
    const sawFirst = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const ark = client(async (_url, init) => {
      entered += 1;
      if (entered === 1) firstEntered?.();
      return hangUntilAbort(init?.signal ?? undefined);
    });

    const first = ark.complete(ask);
    await sawFirst;
    const second = ark.complete(ask);

    const errors = await Promise.allSettled([first, second]);
    const secondError = errors[1];
    expect(secondError?.status).toBe("rejected");
    if (secondError?.status !== "rejected") return;
    expect(secondError.reason).toBeInstanceOf(ArkAbortError);
    if (!(secondError.reason instanceof ArkAbortError)) return;
    expect(secondError.reason.timing.inFlightAtStart).toBe(2);
  });

  it("keeps ModelNotOpen as the provider error, not a timeout", async () => {
    const ark = client(async () =>
      Response.json(
        {
          error: {
            code: "ModelNotOpen",
            message: "not activated. Request id: abc",
          },
        },
        { status: 404 },
      ),
    );

    await expect(ark.complete(ask)).rejects.toMatchObject({
      name: "ArkApiError",
      code: "ModelNotOpen",
      status: 404,
    });
    await expect(ark.complete(ask)).rejects.toBeInstanceOf(ArkApiError);
  });

  it("does not report a caller cancel as a timeout", async () => {
    const signal = new AbortController();
    const ark = client(async (_url, init) =>
      hangUntilAbort(init?.signal ?? undefined),
    );
    const pending = ark.complete({ ...ask, signal: signal.signal });
    signal.abort();

    try {
      await pending;
      throw new Error("expected cancel");
    } catch (error) {
      expect(error).toBeInstanceOf(ArkAbortError);
      if (!(error instanceof ArkAbortError)) return;
      expect(error.kind).toBe("cancelled");
      expect(error.summary).toBe("Audit model request was cancelled");
    }
  });
});
