import { z } from "zod";
import type { ArkClient } from "./ark-client.js";

export function extractJson(content: string) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function completeJson<Schema extends z.ZodType>(input: {
  client: ArkClient;
  model: string;
  system: string;
  user: string;
  schema: Schema;
  maxAttempts?: number;
}) {
  const maxAttempts = input.maxAttempts ?? 3;
  let user = input.user;
  let lastError = "Model returned an unparseable verdict";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { content } = await input.client.complete({
      model: input.model,
      system: input.system,
      user,
    });
    const parsed = input.schema.safeParse(extractJson(content));
    if (parsed.success) return parsed.data;
    lastError = parsed.error.message;
    user = [
      input.user,
      "",
      "Your previous response was invalid.",
      "Validation: " + lastError,
      "Previous response:",
      content,
      "Return JSON only.",
    ].join("\n");
  }
  throw new Error(lastError);
}
