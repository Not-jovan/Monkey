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
  // Streaming is asked for so the client's deadline can tell a slow answer from
  // a stuck one; a non-streamed reply withholds headers until generation ends,
  // which collapses the stall budget into a cap on total answer length. The
  // provider is still free to ignore it, so the JSON path below must keep
  // working — that is what this test protects.
  it("asks the provider to stream, and still reads a plain JSON completion", async () => {
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

    expect(body).toMatchObject({ model: "flash", stream: true });
    // Ark reports usage only on the final streamed event, and only when this is
    // set. Without it every audit loses its token accounting.
    expect(body).toMatchObject({ stream_options: { include_usage: true } });
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

  // Ark sends `"usage": null` on every content frame and fills it only on the
  // last. A schema that allowed absent-but-not-null silently failed the parse
  // and dropped each frame, so the answer arrived empty while the call looked
  // successful. Fixtures that simply omit the field cannot catch this.
  it("keeps streamed content when frames carry an explicit null usage", async () => {
    const ark = client(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of ['{"ok"', ":true", "}"]) {
            controller.enqueue(
              encoder.encode(
                sseEvent({
                  id: "s-1",
                  model: "served",
                  usage: null,
                  choices: [{ delta: { content: piece, role: "assistant" }, index: 0 }],
                }),
              ),
            );
          }
          controller.enqueue(
            encoder.encode(
              sseEvent({
                choices: [],
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 3,
                  completion_tokens_details: { reasoning_tokens: 0 },
                },
              }),
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const result = await ark.complete(ask);

    expect(result.content).toBe('{"ok":true}');
    expect(result.model).toBe("served");
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: 0,
    });
  });

  it("stops asking to stream when streaming is turned off", async () => {
    let body: unknown = null;
    const ark = createArkClient(
      {
        arkBaseUrl: "https://ark.test",
        arkApiKey: "k",
        auditModelStream: false,
      },
      timeoutMs,
      async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      },
    );

    const result = await ark.complete(ask);

    expect(body).not.toHaveProperty("stream");
    expect(body).not.toHaveProperty("stream_options");
    // The JSON path still answers, which is what makes this a safe fallback.
    expect(result.content).toBe("{}");
  });

  it("leaves the reasoning control out unless it is configured", async () => {
    let body: unknown = null;
    const ark = client(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    });

    await ark.complete(ask);

    expect(body).not.toHaveProperty("thinking");
  });

  it("asks a reasoning model to skip thinking when configured to", async () => {
    let body: unknown = null;
    const ark = createArkClient(
      {
        arkBaseUrl: "https://ark.test",
        arkApiKey: "k",
        auditModelThinking: "disabled",
      },
      timeoutMs,
      async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      },
    );

    await ark.complete(ask);

    expect(body).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("records reasoning tokens billed inside the output count", async () => {
    const ark = client(async () =>
      Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 900,
          completion_tokens_details: { reasoning_tokens: 850 },
        },
      }),
    );

    const result = await ark.complete(ask);

    // 850 of the 900 billed output tokens never reached the answer. The trace
    // UI already draws this share; it read zero only because it was not parsed.
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 900,
      reasoningTokens: 850,
    });
  });

  // The regression that motivated the stall timer: a long verdict is not a
  // stuck request, but a single total-time deadline cannot tell them apart.
  it("lets a stream that keeps producing outlive one stall budget", async () => {
    const stallMs = 200;
    const gapMs = 60;
    const ark = createArkClient(
      { arkBaseUrl: "https://ark.test", arkApiKey: "k" },
      stallMs,
      async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Six gaps at 60ms run to ~360ms, comfortably past the 200ms
            // budget, while no single gap comes close to exhausting it.
            for (let i = 0; i < 6; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, gapMs));
              controller.enqueue(
                encoder.encode(
                  sseEvent({ choices: [{ delta: { content: "x" } }] }),
                ),
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );

    const result = await ark.complete(ask);

    expect(result.content).toBe("xxxxxx");
    expect(result.timing.chunkCount).toBe(6);
  });
});

// The provider caches a shared prompt prefix by itself and reports the hit
// here. Nothing else says whether that happened, so this is the instrument the
// staggered step checks are measured with — on both reply shapes, since
// AUDIT_MODEL_STREAM decides which one arrives.
describe("createArkClient cache reporting", () => {
  it("reads cached tokens off a non-streamed reply", async () => {
    const ark = client(async () =>
      Response.json({
        id: "json-cached",
        model: "served",
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 18_000,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 17_800 },
        },
      }),
    );

    const result = await ark.complete(ask);

    expect(result.usage).toEqual({
      inputTokens: 18_000,
      cachedInputTokens: 17_800,
      outputTokens: 12,
    });
  });

  it("reads cached tokens off the streamed usage event too", async () => {
    const ark = client(
      async () =>
        new Response(
          sseEvent({
            choices: [{ delta: { content: '{"ok":true}' } }],
          }) +
            sseEvent({
              usage: {
                prompt_tokens: 900,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 850 },
              },
            }) +
            "data: [DONE]\n\n",
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );

    const result = await ark.complete(ask);

    expect(result.usage).toEqual({
      inputTokens: 900,
      cachedInputTokens: 850,
      outputTokens: 5,
    });
  });
});
