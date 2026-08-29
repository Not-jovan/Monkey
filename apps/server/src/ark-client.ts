import { z } from "zod";
import type { RunUsage } from "./types.js";

// Every field is optional and read defensively: a malformed or absent usage
// block must never cost the caller the verdict it came with.
const usageResponse = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().optional() })
    .optional(),
});

const completionResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: usageResponse.optional(),
  // What actually served the request, which is not always what was asked for:
  // Ark resolves an endpoint id to a concrete model. Reported so an auditor
  // run can name its model the way a runtime run does.
  model: z.string().optional(),
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

function isAbortError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  if (!("name" in error)) return false;
  return error.name === "AbortError";
}

function readUsage(usage: z.infer<typeof usageResponse> | undefined): RunUsage | null {
  if (!usage) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    ...(usage.prompt_tokens !== undefined
      ? { inputTokens: usage.prompt_tokens }
      : {}),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(usage.completion_tokens !== undefined
      ? { outputTokens: usage.completion_tokens }
      : {}),
  };
}

interface ArkClientConfig {
  arkBaseUrl: string;
  arkApiKey: string;
}

export function createArkClient(config: ArkClientConfig, timeoutMs = 60_000) {
  const complete = async (input: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
    // Cancels this request. Provided by a caller that owns cancellation for a
    // whole run rather than for one call, so the timer below stays the only
    // deadline this client imposes.
    signal?: AbortSignal;
  }) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(config.arkBaseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.arkApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          // Audit models reason before answering; leave room for both.
          max_tokens: input.maxTokens ?? 2_048,
        }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
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
      const parsed = completionResponse.parse(body);
      return {
        content: parsed.choices[0]?.message.content ?? "",
        usage: readUsage(parsed.usage),
        model: parsed.model ?? null,
      };
    } catch (error) {
      if (isAbortError(error)) {
        // A caller-driven cancellation is not a timeout, and reporting it as
        // one would blame the provider for something the platform did.
        if (input.signal?.aborted) {
          throw new Error("Audit model request was cancelled");
        }
        throw new Error(
          "Audit model timed out after " + timeoutMs / 1000 + "s",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  };
  return { complete };
}

export type ArkClient = ReturnType<typeof createArkClient>;
