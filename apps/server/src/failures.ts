// A failed run is evidence about the agent, and the first question is always
// "whose fault is it". A sandbox denial, an unactivated Ark model and a broken
// shell command all end a run, but only the last says anything about the agent.
// Collapsing them into one "the run failed" string is how a team ends up tuning
// an agent that was never at fault, so attribution is computed before anything
// is rendered.

import { z } from "zod";

export const failureLayerSchema = z.enum([
  // The launchpad itself: container engine, image, timeouts, output caps.
  "platform",
  // Ark: unactivated model, rate limit, context window, auth, unreachable.
  "provider",
  // A boundary doing its job: sandbox denial, approval denial, blocked egress.
  "policy",
  // The agent's own work: a command it wrote failed.
  "agent",
  // The run mechanically succeeded but produced nothing usable.
  "task",
  // The operator stopped it. Not a fault at all.
  "user",
]);
export const retryabilitySchema = z.enum([
  "transient",
  "permanent",
  "user-action",
]);

export const runFailureSchema = z.object({
  layer: failureLayerSchema,
  kind: z.string(),
  retryability: retryabilitySchema,
  title: z.string(),
  detail: z.string(),
  remedy: z.string(),
  exitCode: z.number().nullable(),
});

export type FailureLayer = z.infer<typeof failureLayerSchema>;

// Whether trying again could plausibly help. Mirrors the distinction the
// auditor already draws for its own models, so the two cannot disagree.
export type Retryability = z.infer<typeof retryabilitySchema>;

// title  — one line, safe to use as a headline.
// detail — the evidence, verbatim where possible. The caller redacts it before
//          it is stored; this module never sees a masking function.
// remedy — what the reader should do next, which is the whole reason
//          attribution is worth computing.
export type RunFailure = z.infer<typeof runFailureSchema>;

// Only these two layers mean the agent is what needs improving. Everything else
// is the platform, the provider, a policy boundary, or the operator.
//
// A record rather than a predicate so that adding a layer is a compile error
// here, the way it already is in the web's LAYER_COPY. A new layer silently
// defaulting to "not the agent" would be a quiet wrong answer.
const BLAMES_AGENT: Record<FailureLayer, boolean> = {
  platform: false,
  provider: false,
  policy: false,
  agent: true,
  task: true,
  user: false,
};

// Takes just the layer so a grouped or partial record can be ranked the same
// way. An unrecognised layer is never blamed on the agent.
export function blamesAgent(failure: { layer: string }): boolean {
  return BLAMES_AGENT[failure.layer as FailureLayer] ?? false;
}

export class RunFailureError extends Error {
  constructor(public readonly failure: RunFailure) {
    super(failure.title + (failure.detail ? ": " + failure.detail : ""));
    this.name = "RunFailureError";
  }
}

// Where the evidence came from. This gates whether the agent can be blamed at
// all: "SyntaxError" in a command's own output means the agent wrote bad code,
// but the same word in a provider's JSON error body means nothing of the sort,
// and pattern matching alone cannot tell them apart.
export type EvidenceSource =
  // The output or error of a tool call the agent made.
  | "tool-step"
  // The Runtime process exited non-zero; the evidence is its own output.
  | "process-exit"
  // A message from somewhere else — an SDK error, a thrown Error, a provider
  // response body. Never attributable to the agent.
  | "unknown";

export interface ClassifyHints {
  exitCode?: number | null;
  source?: EvidenceSource;
  // Set by the runner when it knows the cause outright, so those cases never
  // depend on matching prose.
  cancelled?: boolean;
  timedOut?: boolean;
  outputExceeded?: boolean;
  spawnFailed?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type Verdict = Omit<RunFailure, "detail" | "exitCode">;
type Rule = Verdict & {
  pattern: RegExp;
  // A rule that may only fire for certain evidence. Absent means "any".
  onlyWhen?: (hints: ClassifyHints) => boolean;
};

// The agent is only implicated when the text is a command's own output. A
// misattribution here is worse than no attribution: it points the reader at
// the agent when the platform or the provider is at fault, which is the exact
// mistake this taxonomy exists to prevent.
function isAgentOutput(hints: ClassifyHints) {
  if (hints.source === "tool-step" || hints.source === "process-exit") {
    return true;
  }
  // A non-zero exit means a process ran and failed, which is the same evidence
  // in all but name; the runners were passing exitCode before `source` existed.
  return typeof hints.exitCode === "number" && hints.exitCode !== 0;
}

// Ordered: the first match wins, so the specific sits above the general.
const RULES: Rule[] = [
  {
    layer: "policy",
    kind: "sandbox-denied",
    retryability: "user-action",
    title: "The Runtime sandbox denied this operation",
    remedy:
      "The boundary worked as configured. Keep the work inside /workspace, or widen CODEX_SANDBOX_MODE if the operation is genuinely required.",
    pattern: /SandboxDenied|sandbox.{0,12}den(y|ied)|operation not permitted/i,
  },
  {
    layer: "policy",
    kind: "approval-denied",
    retryability: "user-action",
    title: "A tool call was denied before it ran",
    remedy:
      "The approval policy rejected this call. Review approvalPolicy on the turn span if the call should have been allowed.",
    pattern: /tool call (denied|abort)|approval.{0,12}(denied|rejected)/i,
  },
  {
    layer: "provider",
    kind: "model-unavailable",
    retryability: "permanent",
    title: "The Ark model is not available to this account",
    remedy:
      "Activate the model in the Ark console, or point ARK_MODEL at an endpoint this account can use. Retrying will not help.",
    pattern:
      /ModelNotOpen|ModelNotFound|model.{0,20}not (open|found|activated)/i,
  },
  {
    layer: "provider",
    kind: "rate-limited",
    retryability: "transient",
    title: "Ark rate-limited this run",
    remedy: "Wait and retry, or reduce the number of concurrent runs.",
    pattern: /rate.?limit|too many requests|\b429\b/i,
  },
  {
    layer: "provider",
    kind: "context-length-exceeded",
    retryability: "permanent",
    title: "The conversation exceeded the model's context window",
    remedy:
      "Start a fresh session for this agent, or narrow the task so the thread stays inside the window.",
    pattern:
      /context.{0,10}(length|window).{0,20}exceed|maximum context length/i,
  },
  // Ahead of the Ark rule below because the two overlap on bare status codes,
  // and the remedy is what makes attribution worth computing: pointing a
  // Claude Code operator at ARK_API_KEY sends them to the wrong file. Matched
  // on the shapes Claude Code actually emits, verified against a live run —
  // note `authentication_failed` with an underscore, which the Ark rule's
  // `authentication failed` does not match.
  {
    layer: "provider",
    kind: "auth-rejected",
    retryability: "user-action",
    title: "The Agent runtime is not authenticated",
    remedy:
      "Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY, then restart the control plane.",
    pattern: /authentication_failed|not logged in|please run \/login/i,
  },
  // A credential that authenticates but cannot pay is the provider refusing
  // the work, not the platform failing — and the operator, not the agent, is
  // who can fix it.
  {
    layer: "provider",
    kind: "billing-rejected",
    retryability: "user-action",
    title: "The provider rejected the request for billing reasons",
    remedy:
      "Top up the account behind the runtime's credential, or switch to a credential with available balance.",
    pattern: /billing_error|credit balance is too low|insufficient (quota|credit|balance)/i,
  },
  // Claude Code refuses to bypass its own permission prompts for uid 0 and
  // exits immediately, before the run does any work at all — so the evidence
  // is one line of stderr and nothing else. Attributed to the platform
  // because it is the Launchpad's choice of container user that decides this,
  // not the provider and certainly not the agent. Reachable through
  // CONTAINER_USER=0:0, a control plane running as root, or a local-process
  // server started under sudo.
  {
    layer: "platform",
    kind: "container-misconfigured",
    retryability: "user-action",
    title: "The Agent runtime refused to run as root",
    remedy:
      "Run the Agent Runtime as a non-root user: set CONTAINER_USER to a uid:gid, " +
      "or start the control plane as a normal user, then retry.",
    pattern: /cannot be used with root\/sudo privileges/i,
  },
  {
    layer: "provider",
    kind: "auth-rejected",
    retryability: "user-action",
    title: "Ark rejected the credentials",
    remedy: "Check ARK_API_KEY, then restart the control plane.",
    pattern:
      /\b(401|403|unauthorized|forbidden)\b|invalid api key|authentication failed/i,
  },
  {
    layer: "provider",
    kind: "provider-unreachable",
    retryability: "transient",
    title: "Ark could not be reached",
    remedy: "Check network egress to the Ark base URL, then retry.",
    pattern:
      /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b|socket hang up|network error|fetch failed/i,
  },
  {
    layer: "platform",
    kind: "container-unavailable",
    retryability: "user-action",
    title: "The Runtime container could not be started",
    remedy:
      "The container engine or the Agent Runtime image is missing. Rerun npm run poc to rebuild it.",
    pattern:
      /\bENOENT\b|no such image|image .{0,60}not found|cannot connect to the docker daemon|permission denied while trying to connect/i,
  },
  {
    layer: "agent",
    kind: "tool-failed",
    retryability: "transient",
    title: "A command the agent wrote failed",
    remedy:
      "This is the agent's own work. Read the failing step's command and output, then correct the instructions or add a standing constraint.",
    pattern:
      /command not found|No such file or directory|npm ERR!|SyntaxError|Traceback \(most recent call last\)/i,
    // These words appear in plenty of text that has nothing to do with the
    // agent — a provider error body, a stack trace from the control plane. Only
    // a command's own output earns the agent layer.
    onlyWhen: isAgentOutput,
  },
];

const UNKNOWN: Verdict = {
  layer: "platform",
  kind: "unknown",
  retryability: "transient",
  title: "The run failed for an unrecognised reason",
  remedy:
    "Open the failing step and read the raw output. If this recurs, the taxonomy in apps/server/src/failures.ts needs a rule for it.",
};

const DETAIL_LIMIT = 300;

// The lines worth quoting out of a wall of Rust Debug syntax. Deliberately a
// small set: this is a one-line summary, not the structured breakdown the web
// parser produces from the same text.
const QUOTABLE = [
  /^[A-Za-z]*Error: .+/,
  /command not found/,
  /[Pp]ermission denied/,
  /No such file or directory/,
  /operation not permitted/i,
];

// The evidence reduced to the line a person would quote.
//
// `detail` used to be whatever text the classifier was handed. For a tool step
// that is the entire failure envelope — kilobytes of struct syntax, duplicated
// from the span it came from, and cut mid-escape by an upstream clip. The full
// text stays on the span; this is the part worth reading.
function summarizeEvidence(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return "";

  // The envelope arrives as one line with its newlines escaped, so split on
  // both the real and the literal form.
  const lines = text
    .split(/\\n|\n|\r/)
    .map((line) => line.replace(/\\+$/, "").trim())
    .filter((line) => line.length > 0);

  // Short and already one line: there is nothing to summarise.
  if (lines.length <= 1 && text.length <= DETAIL_LIMIT) return text;

  const quotable = lines.find((line) =>
    QUOTABLE.some((pattern) => pattern.test(line)),
  );
  const chosen = quotable ?? lines[0] ?? text;
  // A short envelope has no newline before its payload, so the chosen "line"
  // still carries the struct preamble. Codex always puts the payload in a
  // `text: "..."` field, which is the boundary to cut at — greedy, so the last
  // such field wins over the empty stdout one that precedes it.
  const payload = chosen.replace(/^.*\btext:\s*\\*"/, "").trim();
  const summary = payload.length > 0 ? payload : chosen;
  return summary.length > DETAIL_LIMIT
    ? summary.slice(0, DETAIL_LIMIT) + "…"
    : summary;
}

function build(
  verdict: Verdict,
  detail: string,
  exitCode: number | null,
): RunFailure {
  return { ...verdict, detail: summarizeEvidence(detail), exitCode };
}

export function classifyRunFailure(
  raw: string,
  hints: ClassifyHints = {},
): RunFailure {
  const exitCode = hints.exitCode ?? null;

  // States the runner observed directly always beat pattern matching: it knows
  // it killed the container, and no amount of prose should override that.
  if (hints.cancelled) {
    return build(
      {
        layer: "user",
        kind: "cancelled",
        retryability: "user-action",
        title: "The run was stopped",
        remedy: "Nothing failed. Send the message again to start a new run.",
      },
      raw,
      exitCode,
    );
  }
  if (hints.timedOut) {
    return build(
      {
        layer: "platform",
        kind: "runtime-timeout",
        retryability: "transient",
        title:
          "The Runtime exceeded its time budget" +
          (hints.timeoutMs ? " of " + hints.timeoutMs + " ms" : ""),
        remedy:
          "Raise CODEX_TIMEOUT_MS, or split the task. Check the trace for the step that stalled.",
      },
      raw,
      exitCode,
    );
  }
  if (hints.outputExceeded) {
    return build(
      {
        layer: "platform",
        kind: "output-cap",
        retryability: "transient",
        title:
          "The Runtime exceeded its output budget" +
          (hints.maxOutputBytes ? " of " + hints.maxOutputBytes + " bytes" : ""),
        remedy:
          "Raise CODEX_MAX_OUTPUT_BYTES, or stop the agent dumping large files. Evidence for this run is incomplete.",
      },
      raw,
      exitCode,
    );
  }
  if (hints.spawnFailed) {
    return build(
      {
        layer: "platform",
        kind: "container-unavailable",
        retryability: "user-action",
        title: "The Runtime process could not be spawned",
        remedy:
          "The container engine or the Agent Runtime image is missing. Rerun npm run poc to rebuild it.",
      },
      raw,
      exitCode,
    );
  }

  for (const rule of RULES) {
    if (!rule.pattern.test(raw)) continue;
    if (rule.onlyWhen && !rule.onlyWhen(hints)) continue;
    const { pattern: _pattern, onlyWhen: _onlyWhen, ...verdict } = rule;
    return build(verdict, raw, exitCode);
  }
  return build(UNKNOWN, raw, exitCode);
}

// Codex exited cleanly but produced nothing to show the user. Mechanically a
// success, materially a failed task — kept distinct so it is never mistaken for
// a platform fault.
export function noAgentMessageFailure(): RunFailure {
  return build(
    {
      layer: "task",
      kind: "no-agent-message",
      retryability: "transient",
      title: "The agent finished without producing a reply",
      remedy:
        "The run completed but said nothing. Read the last model call in the trace; the task was probably too vague to act on.",
    },
    "Codex completed without an agent message",
    0,
  );
}

// The auditor draws the same distinction for its own models. Shared so a
// provider error cannot be permanent in one place and transient in the other.
export function isPermanentProviderError(
  status: number,
  code: string | null,
): boolean {
  return status === 404 || code === "ModelNotOpen" || code === "ModelNotFound";
}
