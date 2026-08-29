import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { isPermanentProviderError } from "../../failures.js";
import type { TraceSpan } from "../trace/trace-model.js";
import { ArkApiError, type ArkClient } from "../../ark-client.js";

// Everything about asking the audit model a question and living with the
// answer: the fallback, what counts as a permanent failure, and the record of
// each attempt. Separated from the checks themselves because none of it is
// about auditing — a check should say what it wants judged, not how a provider
// misbehaves.

// Reasoning and the answer share this budget. The default left a reasoning
// model no room to finish the JSON it had started.
const VERDICT_MAX_TOKENS = 4_096;

export interface AuditorCallAttempt {
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  content: string;
  error: string | null;
}

export type AuditorCallStatus = "completed" | "degraded" | "failed";

export interface AuditorAnswer<Verdict> {
  verdict: Verdict | null;
  model: string;
  status: AuditorCallStatus;
  failure: string | null;
  attempts: AuditorCallAttempt[];
}

// Models answer in prose around their JSON often enough that this is the normal
// path, not a fallback.
export function extractJson(content: string) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export function describeError(error: unknown) {
  if (error instanceof ArkApiError) {
    return error.code ? error.code + ": " + error.message : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The same error as {@link describeError}, minus the parts the provider stamps
 * per response. Ark ends every failure with its own request id, so one outage
 * reported by seven checks is seven strings that differ only in that id —
 * nothing downstream can tell it is one outage, and the auditor's health then
 * repeats the same sentence once per check.
 *
 * Used for what a check *reports*. The id is not lost: the attempt keeps the
 * full message, which is what the auditor's own span carries and what the log
 * line below prints.
 */
export function summarizeError(error: unknown) {
  return describeError(error)
    .replace(/\s*Request id:\s*\S+/gi, "")
    .trim();
}

// One attempt, as a span in the agent's own shape. That compatibility is what
// makes the auditor's own trace auditable by the machinery that judges an agent.
export function auditorCallSpan(input: {
  traceId: string;
  name: string;
  label: string;
  targetSpanId: string | null;
  prompt: string;
  attempt: AuditorCallAttempt;
  fallback: boolean;
}): TraceSpan {
  return {
    id: randomUUID(),
    traceId: input.traceId,
    parentId: null,
    name: input.name,
    label: input.label,
    kind: "model_call",
    actor: "system",
    status: input.attempt.error ? "error" : "ok",
    startedAt: input.attempt.startedAt,
    endedAt: input.attempt.endedAt,
    durationMs: input.attempt.durationMs,
    attributes: {
      model: input.attempt.model,
      context: input.prompt,
      output: input.attempt.content,
      // Whether this call judged one step or the whole run. The forward-trace
      // and backtrace read every step at once, so they belong with the run.
      phase: input.name.startsWith("audit.step") ? "step" : "run",
      laneId: "auditor",
      ...(input.fallback ? { fallback: true } : {}),
      ...(input.targetSpanId ? { targetSpanId: input.targetSpanId } : {}),
    },
    error: input.attempt.error,
  };
}

export class AuditorModel {
  // A model the account has not activated will not start working inside this
  // process. Remembering it turns "one wasted request per check" into one
  // wasted request per boot. Held here rather than per chat, because a model
  // that does not exist for this account does not exist for the next chat.
  //
  // Keyed by model, holding why: a check that skips the call still reports the
  // reason the first one was given, so one outage reads as one sentence
  // instead of as the provider's explanation and a bare "not available",
  // decided by which check happened to run first.
  private readonly unavailable = new Map<string, string>();

  constructor(
    private readonly client: ArkClient,
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  // Never throws: a failed audit is a finding, not an exception, and every
  // caller needs the attempts either way to record what the auditor tried.
  async complete<Schema extends z.ZodType>(
    primaryModel: string,
    fallbackModel: string | null,
    system: string,
    user: string,
    schema: Schema,
  ): Promise<AuditorAnswer<z.infer<Schema>>> {
    const attempts: AuditorCallAttempt[] = [];
    const runAttempt = async (model: string) => {
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      try {
        const { content } = await this.client.complete({
          model,
          system,
          user,
          maxTokens: VERDICT_MAX_TOKENS,
        });
        const parsed = schema.safeParse(extractJson(content));
        const endedAt = new Date().toISOString();
        const durationMs = Date.now() - startedMs;
        if (!parsed.success) {
          const error = "Audit model returned an unparseable verdict";
          attempts.push({ model, startedAt, endedAt, durationMs, content, error });
          throw new Error(error);
        }
        attempts.push({
          model,
          startedAt,
          endedAt,
          durationMs,
          content,
          error: null,
        });
        return parsed.data as z.infer<Schema>;
      } catch (error) {
        if (attempts.length === 0 || attempts[attempts.length - 1]?.model !== model) {
          attempts.push({
            model,
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedMs,
            content: "",
            error: describeError(error),
          });
        }
        throw error;
      }
    };

    const hasFallback = Boolean(fallbackModel) && fallbackModel !== primaryModel;

    // Already known to be unavailable, so the primary is not tried at all.
    const remembered = this.unavailable.get(primaryModel);
    if (hasFallback && remembered !== undefined) {
      return this.attempt(fallbackModel!, attempts, runAttempt, {
        onSuccess: {
          status: "degraded",
          failure: "Primary audit model unavailable: " + remembered,
        },
        onFailure: (error) => summarizeError(error),
      });
    }

    try {
      return {
        verdict: await runAttempt(primaryModel),
        model: primaryModel,
        status: "completed",
        failure: null,
        attempts,
      };
    } catch (primaryError) {
      const primaryFailure = summarizeError(primaryError);
      if (isPermanentlyUnavailable(primaryError)) {
        this.unavailable.set(primaryModel, primaryFailure);
        // The log keeps the request id the report drops: this is the line an
        // operator takes to the provider.
        this.log?.(
          "audit model " +
            primaryModel +
            " is unavailable; falling back for the rest of this process: " +
            describeError(primaryError),
        );
      }
      if (hasFallback) {
        return this.attempt(fallbackModel!, attempts, runAttempt, {
          onSuccess: {
            status: "degraded",
            failure: "Primary audit model unavailable: " + primaryFailure,
          },
          onFailure: (error) =>
            "Primary: " + primaryFailure + " · Fallback: " + summarizeError(error),
        });
      }
      return {
        verdict: null,
        model: primaryModel,
        status: "failed",
        failure: primaryFailure,
        attempts,
      };
    }
  }

  // The fallback leg, which both entry paths above share: the only difference
  // between them is what they call the failure.
  private async attempt<Verdict>(
    model: string,
    attempts: AuditorCallAttempt[],
    runAttempt: (model: string) => Promise<Verdict>,
    describe: {
      onSuccess: { status: AuditorCallStatus; failure: string };
      onFailure: (error: unknown) => string;
    },
  ): Promise<AuditorAnswer<Verdict>> {
    try {
      return {
        verdict: await runAttempt(model),
        model,
        status: describe.onSuccess.status,
        failure: describe.onSuccess.failure,
        attempts,
      };
    } catch (error) {
      return {
        verdict: null,
        model,
        status: "failed",
        failure: describe.onFailure(error),
        attempts,
      };
    }
  }
}

// Distinguishes "this model does not exist for us" from a transient failure:
// only the former is worth remembering, because rate limits and outages recover.
function isPermanentlyUnavailable(error: unknown) {
  return (
    error instanceof ArkApiError &&
    isPermanentProviderError(error.status, error.code)
  );
}
