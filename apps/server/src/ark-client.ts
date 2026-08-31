import { z } from "zod";
import type {
  ProviderAbortPhase,
  ProviderCallTiming,
  RunUsage,
} from "./types.js";

// Every field is optional and read defensively: a malformed or absent usage
// block must never cost the caller the verdict it came with.
const usageResponse = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().nullish() })
    .nullish(),
  completion_tokens_details: z
    .object({ reasoning_tokens: z.number().nullish() })
    .nullish(),
});

const completionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          reasoning_content: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: usageResponse.nullish(),
  // What actually served the request, which is not always what was asked for:
  // Ark resolves an endpoint id to a concrete model. Reported so an auditor
  // run can name its model the way a runtime run does.
  model: z.string().optional(),
  id: z.string().optional(),
});

// Every field is nullish rather than optional. Ark sends `"usage": null` on
// each content frame and only fills it on the last one; under `.optional()`
// that null failed the parse and the frame was dropped silently, so a streamed
// answer arrived empty. Nothing caught it because the request never asked to
// stream — the fixtures below simply omitted the field.
const streamEvent = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  usage: usageResponse.nullish(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
          })
          .nullish(),
        message: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

const errorResponse = z.object({
  error: z.object({
    code: z.string().optional(),
    message: z.string().optional(),
  }),
});

export class ArkApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ArkApiError";
  }
}

// Timeout and caller-cancel both abort the socket. They are one type so the
// span can carry the same timings either way, and so health can group by
// `summary` rather than by the per-call in-flight count on `message`.
export class ArkAbortError extends Error {
  readonly name = "ArkAbortError";

  constructor(
    message: string,
    public readonly kind: "timeout" | "cancelled",
    public readonly summary: string,
    public readonly timing: ProviderCallTiming,
    public readonly content: string,
    public readonly usage: RunUsage | null,
  ) {
    super(message);
  }
}

function isAbortError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  if (!("name" in error)) return false;
  return error.name === "AbortError";
}

function readUsage(
  usage: z.infer<typeof usageResponse> | null | undefined,
): RunUsage | null {
  if (!usage) return null;
  // Null and absent mean the same thing here — the provider did not report the
  // number — and `exactOptionalPropertyTypes` forbids storing the null.
  const num = (value: number | null | undefined) =>
    typeof value === "number" ? value : undefined;
  const input = num(usage.prompt_tokens);
  const output = num(usage.completion_tokens);
  const cached = num(usage.prompt_tokens_details?.cached_tokens);
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens);
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function readMessageText(message: {
  content?: string | null | undefined;
  reasoning_content?: string | null | undefined;
}) {
  const content = message.content ?? "";
  if (content.length > 0) return content;
  // Reasoning models often spend the budget in reasoning_content and leave
  // content empty. The verdict JSON is still in that text.
  return message.reasoning_content ?? "";
}

function utf8Bytes(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

function headerRequestId(headers: Headers) {
  return (
    headers.get("x-request-id") ??
    headers.get("x-ark-request-id") ??
    headers.get("request-id")
  );
}

function takeSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events: string[] = [];
  for (const block of parts) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
  }
  return { events, rest };
}

// The wording matters more than it looks. These messages are the whole record
// of why a check has no verdict, and the previous version led with the
// in-flight count on every timeout — which reads as a queueing problem and sent
// one investigation looking at concurrency when the cause was answer length.
// Elapsed is reported separately from the budget because the stall timer
// restarts, so a call can legitimately outlive a single budget.
function formatTimeout(
  timeoutMs: number,
  timing: ProviderCallTiming,
  elapsedMs: number,
) {
  const seconds = String(timeoutMs / 1000);
  const spent = (elapsedMs / 1000).toFixed(1) + "s";
  const load = " (" + timing.inFlightAtStart + " in flight)";
  if (timing.headersMs === null) {
    return {
      summary: "Audit model timed out after " + seconds + "s waiting for headers",
      message:
        "Audit model sent nothing for " +
        seconds +
        "s and was dropped at " +
        spent +
        "; no response headers arrived" +
        load,
    };
  }
  const headers = (timing.headersMs / 1000).toFixed(1) + "s";
  if (timing.chunkCount === 0) {
    return {
      summary:
        "Audit model timed out after " + seconds + "s; headers received, no tokens",
      message:
        "Audit model timed out after " +
        seconds +
        "s; headers at " +
        headers +
        ", no tokens" +
        load,
    };
  }
  if (timing.ttftMs === null) {
    return {
      summary:
        "Audit model timed out after " +
        seconds +
        "s; stream opened, no answer text",
      message:
        "Audit model reasoned for " +
        spent +
        " without an answer; headers at " +
        headers +
        ", " +
        timing.chunkCount +
        " chunks" +
        load,
    };
  }
  return {
    summary: "Audit model timed out after " + seconds + "s while streaming",
    message:
      "Audit model stopped sending for " +
      seconds +
      "s after " +
      spent +
      "; first token at " +
      (timing.ttftMs / 1000).toFixed(1) +
      "s, " +
      timing.chunkCount +
      " chunks" +
      load,
  };
}

interface ArkClientConfig {
  arkBaseUrl: string;
  arkApiKey: string;
  // Optional so a caller that does not care keeps the provider's own default.
  // AppConfig satisfies this structurally, so the composition root passes it
  // without naming the field.
  auditModelThinking?: "disabled" | "enabled" | "auto";
  // Defaults on. Off restores the pre-streaming behaviour, in which the
  // provider withholds headers until generation ends and the deadline below
  // therefore caps total answer length rather than detecting a stall.
  auditModelStream?: boolean;
}

export interface ArkCompletion {
  content: string;
  usage: RunUsage | null;
  model: string | null;
  timing: ProviderCallTiming;
}

// A stream that keeps producing is allowed this many stall budgets in total,
// so "slow" stays possible while "trickling forever" still ends.
const TOTAL_BUDGET_MULTIPLIER = 5;

export function createArkClient(
  config: ArkClientConfig,
  timeoutMs = 60_000,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const thinking = config.auditModelThinking ?? "disabled";
  const wantStream = config.auditModelStream ?? true;
  let inFlight = 0;

  const complete = async (input: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
    // Cancels this request. Provided by a caller that owns cancellation for a
    // whole run rather than for one call, so the timers below stay the only
    // deadlines this client imposes.
    signal?: AbortSignal;
  }): Promise<ArkCompletion> => {
    inFlight += 1;
    const inFlightAtStart = inFlight;
    const started = Date.now();
    let abortPhase: ProviderAbortPhase = "waiting_for_headers";
    let headersMs: number | null = null;
    let ttftMs: number | null = null;
    let lastChunkMs: number | null = null;
    let chunkCount = 0;
    let requestId: string | null = null;
    let content = "";
    let reasoning = "";
    let usage: RunUsage | null = null;
    let model: string | null = null;

    const snapshot = (): ProviderCallTiming => ({
      promptBytes: utf8Bytes(input.system) + utf8Bytes(input.user),
      inFlightAtStart,
      headersMs,
      ttftMs,
      lastChunkMs,
      chunkCount,
      requestId,
      abortPhase,
    });

    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    // Two deadlines, because "slow" and "stuck" are different failures. The
    // stall timer restarts on answer text, so a long verdict is fine as long
    // as it keeps arriving; the ceiling still bounds a stream that never ends.
    // Reasoning does not restart it. A thinking model can otherwise sit in
    // reasoning_content until the 5x ceiling and never emit a verdict.
    // Without streaming these collapse into one total-generation cap, which is
    // what made a verbose verdict indistinguishable from a hung request.
    const ceiling = started + timeoutMs * TOTAL_BUDGET_MULTIPLIER;
    let timer = setTimeout(abort, timeoutMs);
    const restartStallTimer = () => {
      clearTimeout(timer);
      const remaining = ceiling - Date.now();
      if (remaining <= 0) {
        abort();
        return;
      }
      timer = setTimeout(abort, Math.min(timeoutMs, remaining));
    };

    const failAbort = (kind: "timeout" | "cancelled"): never => {
      if (content.length === 0 && reasoning.length > 0) content = reasoning;
      const timing = snapshot();
      if (kind === "cancelled") {
        throw new ArkAbortError(
          "Audit model request was cancelled",
          "cancelled",
          "Audit model request was cancelled",
          timing,
          content,
          usage,
        );
      }
      const described = formatTimeout(timeoutMs, timing, Date.now() - started);
      throw new ArkAbortError(
        described.message,
        "timeout",
        described.summary,
        timing,
        content,
        usage,
      );
    };

    const markChunk = (at: number) => {
      chunkCount += 1;
      lastChunkMs = at;
      if (abortPhase === "waiting_for_first_token") abortPhase = "streaming";
    };

    const takeContent = (piece: string) => {
      if (piece.length === 0) return;
      if (ttftMs === null) ttftMs = Date.now() - started;
      content += piece;
      restartStallTimer();
    };

    const send = () =>
      fetchImpl(config.arkBaseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.arkApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          // System first, then the evidence. The provider caches on a common
          // leading prefix, so what several calls share has to stay at the
          // front and what differs between them has to trail it.
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          // Audit models reason before answering; leave room for both.
          max_tokens: input.maxTokens ?? 2_048,
          // Asked for so the deadline above can tell a slow answer from a
          // stuck one. A non-streamed reply withholds headers until the whole
          // answer exists, which turns every stall budget into a cap on total
          // generation time. The JSON branch below still handles a provider
          // that ignores this, which is also what serves
          // AUDIT_MODEL_STREAM=false.
          //
          // Ark reports usage only on the final streamed event, and only when
          // stream_options is set; without it the audit loses token
          // accounting.
          ...(wantStream
            ? { stream: true, stream_options: { include_usage: true } }
            : {}),
          // Audits are short JSON. Leaving thinking on "auto" lets DeepSeek
          // spend the whole stall budget in reasoning_content and never emit
          // the verdict — measured at 4k+ chunks, 60s, empty answer. "auto"
          // therefore means off. Set AUDIT_MODEL_THINKING=enabled to opt in.
          ...(thinking === "enabled"
            ? { thinking: { type: "enabled" } }
            : { thinking: { type: "disabled" } }),
        }),
        signal: controller.signal,
      });

    try {
      const response = await send();
      headersMs = Date.now() - started;
      abortPhase = "waiting_for_first_token";
      requestId = headerRequestId(response.headers);

      const body: unknown = !response.ok
        ? await response.json().catch(() => null)
        : null;
      if (!response.ok) {
        const parsed = errorResponse.safeParse(body);
        throw new ArkApiError(
          parsed.success
            ? (parsed.data.error.message ?? "Ark request failed")
            : "Ark request failed with HTTP " + response.status,
          parsed.success ? (parsed.data.error.code ?? null) : null,
          response.status,
        );
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      // Completions are JSON. Only read SSE if the provider actually streamed.
      const streamed = contentType.includes("event-stream") && response.body !== null;

      if (!streamed) {
        const json: unknown = await response.json().catch(() => null);
        const parsed = completionResponse.parse(json);
        content = readMessageText(parsed.choices[0]?.message ?? {});
        usage = readUsage(parsed.usage);
        model = parsed.model ?? null;
        if (!requestId && parsed.id) requestId = parsed.id;
        const elapsed = Date.now() - started;
        lastChunkMs = elapsed;
        chunkCount = 1;
        if (content.length > 0) {
          ttftMs = elapsed;
          abortPhase = "streaming";
        }
        return {
          content,
          usage,
          model,
          timing: { ...snapshot(), abortPhase: null },
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = (raw: string) => {
        if (raw === "[DONE]") return;
        let value: unknown = null;
        try {
          value = JSON.parse(raw);
        } catch {
          return;
        }
        const parsed = streamEvent.safeParse(value);
        if (!parsed.success) return;
        const event = parsed.data;
        if (!requestId && event.id) requestId = event.id;
        if (event.model) model = event.model;
        const nextUsage = readUsage(event.usage);
        if (nextUsage) usage = nextUsage;
        const choice = event.choices?.[0];
        const delta = choice?.delta;
        const reasoningPiece =
          typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof choice?.message?.reasoning_content === "string"
              ? choice.message.reasoning_content
              : "";
        const piece =
          typeof delta?.content === "string"
            ? delta.content
            : typeof choice?.message?.content === "string"
              ? choice.message.content
              : "";
        if (delta !== undefined || choice?.message !== undefined) {
          markChunk(Date.now() - started);
        } else if (event.usage) {
          markChunk(Date.now() - started);
        }
        if (reasoningPiece.length > 0) {
          reasoning += reasoningPiece;
          if (abortPhase === "waiting_for_first_token") abortPhase = "streaming";
        }
        takeContent(piece);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const flushed = takeSseEvents(buffer + "\n\n");
          for (const event of flushed.events) consume(event);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const flushed = takeSseEvents(buffer);
        buffer = flushed.rest;
        for (const event of flushed.events) consume(event);
      }

      if (content.length === 0) content = reasoning;

      return {
        content,
        usage,
        model,
        timing: { ...snapshot(), abortPhase: null },
      };
    } catch (error) {
      if (isAbortError(error)) {
        failAbort(input.signal?.aborted ? "cancelled" : "timeout");
      }
      throw error;
    } finally {
      inFlight -= 1;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  };
  return { complete };
}

export type ArkClient = ReturnType<typeof createArkClient>;
