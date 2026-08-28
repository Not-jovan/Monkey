import type {
  FailureLayer,
  Retryability,
  RunFailure,
  TraceRecord,
  TraceSpan,
} from "../types";
import { parseCodexFailure, type CodexFailure } from "./codex-error";
import { stepHeadline } from "./steps";

// Turns a failed run into an answer to "why did this fail, and is it the agent's
// fault". The second half matters as much as the first: a sandbox denial and a
// broken shell command both end a run, but only one of them is a reason to
// change the agent, and a reader who cannot tell them apart will tune the wrong
// thing.

export interface LayerCopy {
  label: string;
  blame: "agent" | "environment";
  note: string;
}

export const LAYER_COPY: Record<FailureLayer, LayerCopy> = {
  platform: {
    label: "Platform",
    blame: "environment",
    note: "The launchpad itself failed. Not an agent defect.",
  },
  provider: {
    label: "Provider",
    blame: "environment",
    note: "Ark refused or could not serve the request. Not an agent defect.",
  },
  policy: {
    label: "Policy",
    blame: "environment",
    note: "A boundary did its job and blocked the action. Not an agent defect.",
  },
  agent: {
    label: "Agent",
    blame: "agent",
    note: "The agent's own work failed. This is the one worth improving.",
  },
  task: {
    label: "Task",
    blame: "agent",
    note: "The run finished but produced nothing usable.",
  },
  user: {
    label: "Stopped",
    blame: "environment",
    note: "You stopped this run. Nothing failed.",
  },
};

const RETRYABILITY_COPY: Record<Retryability, string> = {
  transient: "Retrying may work",
  permanent: "Retrying will not help",
  "user-action": "Needs a change before retrying",
};

export interface DiagnosisAnchor {
  spanId: string;
  label: string;
}

export interface Diagnosis {
  // "failed" — the run stopped here. "recovered" — the step broke and the agent
  // carried on. The second is the common case for a sandbox denial and used to
  // render nothing at all, because the diagnosis was gated on the run's status
  // rather than on there being something wrong to diagnose.
  outcome: "failed" | "recovered";
  headline: string;
  layer: FailureLayer;
  layerLabel: string;
  blame: "agent" | "environment";
  attribution: string;
  kind: string;
  retryability: string;
  remedy: string;
  // The step that broke.
  where: DiagnosisAnchor | null;
  // The model call that was in flight when the failing step was decided.
  // Separating a bad plan from a bad execution is what decides the fix — but
  // this is inferred from event ordering, not reported by the runtime, so it is
  // presented as a likelihood rather than a fact.
  causedBy: DiagnosisAnchor | null;
  // The structured form of the raw envelope, when the evidence is one.
  envelope: CodexFailure | null;
  raw: string;
  evidenceComplete: boolean;
}

function anchor(span: TraceSpan | undefined): DiagnosisAnchor | null {
  if (!span) return null;
  return { spanId: span.id, label: stepHeadline(span) };
}

// The most complete evidence available.
//
// `error` is a 400-character clip of `output`, so preferring it handed the
// parser a truncated envelope: the header still matched, but the payload was
// cut before the stack trace and the whole thing fell through to "other
// output". The full output comes first for that reason, with `error` as the
// fallback for spans that have no output of their own — a stream error, say.
function evidenceFor(
  span: TraceSpan | undefined,
  failure: RunFailure | null,
): string {
  const output = span?.attributes.output;
  if (typeof output === "string" && output.length > 0) return output;
  if (span?.error) return span.error;
  return failure?.detail ?? "";
}

export function buildDiagnosis(trace: TraceRecord): Diagnosis | null {
  const runStopped = trace.status === "failed" || trace.status === "cancelled";
  const failing = trace.spans.find((span) => span.id === trace.failingSpanId);
  // Something has to have gone wrong, but the run need not have stopped. An
  // agent that hits a denial and works around it is arguably the more
  // interesting case: nothing looks broken, and a problem was absorbed.
  if (!runStopped && !failing) return null;

  const failure = trace.failure;
  // A trace can break before attribution ever reached it — an older trace, or a
  // crash recovered at boot. Say so plainly rather than inventing a cause.
  const layer: FailureLayer = failure?.layer ?? "platform";
  const copy = LAYER_COPY[layer];
  const raw = evidenceFor(failing, failure);
  const causedBySpanId = failing?.attributes.causedBySpanId;

  return {
    outcome: runStopped ? "failed" : "recovered",
    headline:
      failure?.title ??
      (runStopped ? "The run failed" : "A step failed during this run"),
    layer,
    layerLabel: copy.label,
    blame: copy.blame,
    attribution: copy.note,
    kind: failure?.kind ?? "unknown",
    retryability: failure
      ? RETRYABILITY_COPY[failure.retryability]
      : RETRYABILITY_COPY.transient,
    remedy:
      failure?.remedy ??
      "Open the failing step below and read its output for the cause.",
    where: anchor(failing),
    causedBy:
      typeof causedBySpanId === "string"
        ? anchor(trace.spans.find((span) => span.id === causedBySpanId))
        : null,
    envelope: raw ? parseCodexFailure(raw) : null,
    raw,
    evidenceComplete: trace.evidenceComplete,
  };
}

// A run that succeeded on the fifth attempt is not a clean run. Surfaced
// separately from failure, because nothing failed in the end — but something
// went wrong five times, and that is the signal worth acting on.
export function recoveryNote(trace: TraceRecord): string | null {
  if (trace.recoveredErrorCount <= 0) return null;
  const count = trace.recoveredErrorCount;
  return (
    "Recovered from " +
    count +
    " error" +
    (count === 1 ? "" : "s") +
    " during this run"
  );
}
