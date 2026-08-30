import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { isPermanentProviderError } from "../../failures.js";
import type { TraceSpan } from "../trace/trace-model.js";
import { ArkAbortError, ArkApiError } from "../../ark-client.js";
import type { AgentRunner, ProviderCallTiming, RunUsage } from "../../types.js";

// Everything about asking the audit model a question and living with the
// answer: the fallback, what counts as a permanent failure, and the record of
// each attempt. Separated from the checks themselves because none of it is
// about auditing — a check should say what it wants judged, not how a provider
// misbehaves.

// Reasoning and the answer share this budget. The default left a reasoning
// model no room to finish the JSON it had started. Exported because the runner
// that applies it is constructed by the middleware, not by this file.
export const VERDICT_MAX_TOKENS = 4_096;

export interface AuditorCallAttempt {
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  content: string;
  error: string | null;
  usage: RunUsage | null;
  timing?: ProviderCallTiming | null;
}

// Who the auditor is running as. An in-process runner ignores the workspace,
// but AgentRunner requires one, and the chat's memory folder is the honest
// answer: it is where this auditor's artifacts already go.
export interface AuditorRun {
  agentId: string;
  workspacePath: string;
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
 * The same error as {@link describeError}, minus the parts that differ per
 * call. Ark request ids and in-flight counts would otherwise make one outage
 * look like seven. The attempt keeps the full message.
 */
export function summarizeError(error: unknown) {
  if (error instanceof ArkAbortError) return error.summary;
  return describeError(error)
    .replace(/\s*Request id:\s*\S+/gi, "")
    .trim();
}

function timingAttributes(timing: ProviderCallTiming | null | undefined) {
  if (!timing) return {};
  return {
    promptBytes: timing.promptBytes,
    inFlightAtStart: timing.inFlightAtStart,
    chunkCount: timing.chunkCount,
    ...(timing.headersMs !== null ? { headersMs: timing.headersMs } : {}),
    ...(timing.ttftMs !== null ? { ttftMs: timing.ttftMs } : {}),
    ...(timing.lastChunkMs !== null ? { lastChunkMs: timing.lastChunkMs } : {}),
    ...(timing.requestId ? { arkRequestId: timing.requestId } : {}),
    ...(timing.abortPhase ? { abortPhase: timing.abortPhase } : {}),
  };
}

// One attempt, as a span in the agent's own shape. That compatibility is what
// makes the auditor's own trace auditable by the machinery that judges an agent.
// Lane and parent are filled by TraceService.recordModelCall — the same fields
// Codex stamps — so the graph never has to guess from this span's name.
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
      ...(input.attempt.usage?.inputTokens !== undefined
        ? { inputTokens: input.attempt.usage.inputTokens }
        : {}),
      ...(input.attempt.usage?.outputTokens !== undefined
        ? { outputTokens: input.attempt.usage.outputTokens }
        : {}),
      ...timingAttributes(input.attempt.timing),
      ...(input.fallback ? { fallback: true } : {}),
      ...(input.targetSpanId ? { targetSpanId: input.targetSpanId } : {}),
    },
    error: input.attempt.error,
  };
}

// The Codex spawn_agent argument the tracer already knows. Step checks are
// subagents; run-level calls (forward-trace, back-trace) are the auditor itself.
export function auditorSubagentType(name: string): string | undefined {
  if (name === "audit.identify") return "identify";
  if (!name.startsWith("audit.step.")) return undefined;
  const key = name.slice("audit.step.".length);
  switch (key) {
    case "summary":
      return "summarize";
    case "intent":
      return "intent";
    case "injection":
      return "injection";
    case "secrets":
      return "secrets";
    case "network":
      return "network";
    case "tool":
      return "tool misuse";
    case "sinks":
      return "sink writes";
    default:
      return key.replace(/-/g, " ");
  }
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
    private readonly runner: AgentRunner,
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  // Never throws: a failed audit is a finding, not an exception, and every
  // caller needs the attempts either way to record what the auditor tried.
  async complete<Schema extends z.ZodType>(
    run: AuditorRun,
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
      let usage: RunUsage | null = null;
      let timing: ProviderCallTiming | null = null;
      try {
        // Through the runner rather than the provider client: an auditor that
        // executes the way an Agent does is one the trace pipeline can record,
        // and a recorded auditor is one that can itself be audited.
        const result = await this.runner.run({
          agentId: run.agentId,
          workspacePath: run.workspacePath,
          prompt: user,
          threadId: null,
          system,
          model,
        });
        usage = result.usage;
        timing = result.timing ?? null;
        const content = result.output;
        const parsed = schema.safeParse(extractJson(content));
        const endedAt = new Date().toISOString();
        const durationMs = Date.now() - startedMs;
        if (!parsed.success) {
          const error = "Audit model returned an unparseable verdict";
          attempts.push({
            model,
            startedAt,
            endedAt,
            durationMs,
            content,
            error,
            usage,
            timing,
          });
          throw new Error(error);
        }
        attempts.push({
          model,
          startedAt,
          endedAt,
          durationMs,
          content,
          error: null,
          usage,
          timing,
        });
        return parsed.data as z.infer<Schema>;
      } catch (error) {
        if (attempts.length === 0 || attempts[attempts.length - 1]?.model !== model) {
          const aborted = error instanceof ArkAbortError ? error : null;
          attempts.push({
            model,
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedMs,
            content: aborted?.content ?? "",
            error: describeError(error),
            usage: aborted?.usage ?? usage,
            timing: aborted?.timing ?? timing,
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
