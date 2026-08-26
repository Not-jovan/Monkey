import { z } from "zod";

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
  }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      return { content: parsed.choices[0]?.message.content ?? "" };
    } finally {
      clearTimeout(timer);
    }
  };
  return { complete };
}

export type ArkClient = ReturnType<typeof createArkClient>;
