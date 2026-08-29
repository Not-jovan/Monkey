import type { PolicyFindings, PromptInjectionFinding, SecretExposureFinding } from "./audit-model.js";
import type { AuditorCallStatus } from "./auditor-model.js";
import type { DeterministicFindings } from "./deterministic.js";
import type {
  InjectionVerdict,
  IntentStepVerdict,
  NetworkVerdict,
  SecretRelevanceVerdict,
  SinkWriteVerdict,
  SummaryVerdict,
  ToolMisuseVerdict,
} from "./step-checks.js";

// Turning seven concurrent verdicts and one deterministic pass into what a step
// actually reports. Kept apart from the service, and kept pure, because this is
// where the auditor decides what to claim — the rules about which findings
// suppress which, and which survive a check that never answered, are the part
// worth reading and testing on their own.

// One check's outcome. The label travels with it so a failure can name the
// question that went unanswered rather than saying the step failed to audit.
export interface StepCheckOutcome<Verdict> {
  verdict: Verdict | null;
  status: AuditorCallStatus;
  failure: string | null;
  label: string;
}

// The four conditional checks are null when the step gave them no subject.
export interface StepCheckOutcomes {
  summary: StepCheckOutcome<SummaryVerdict>;
  intent: StepCheckOutcome<IntentStepVerdict>;
  injection: StepCheckOutcome<InjectionVerdict>;
  secrets: StepCheckOutcome<SecretRelevanceVerdict> | null;
  network: StepCheckOutcome<NetworkVerdict> | null;
  tool: StepCheckOutcome<ToolMisuseVerdict> | null;
  sinks: StepCheckOutcome<SinkWriteVerdict> | null;
}

export interface StepReport {
  status: AuditorCallStatus;
  failure: string | null;
  summary: string;
  policies: PolicyFindings;
  // Signals with no emitter of their own. The ones that do have an emitter are
  // already removed, so pushing these cannot double-report.
  tags: string[];
  reason: string;
}

// Signals the policy emitter already reports by name — the url, the credential,
// the objective, the flag, the file. Re-pushing the bare tag would report the
// same problem twice and inflate the step's count.
const HAS_ITS_OWN_EMITTER = new Set([
  "network-whitelist-violation",
  "secret-egress",
  "secret-exposure",
  "intent-misalignment",
  "injected-objective",
  "prompt-injection",
  "suspicious-action",
  "acted-on-external-directive",
  "tool-misuse",
  "sink-write",
]);

const WORSE: Record<AuditorCallStatus, number> = {
  completed: 0,
  degraded: 1,
  failed: 2,
};

// One step, one health: a step whose injection check fell back has been judged
// less well than one where everything succeeded, whatever the others managed.
function worstStatus(
  checks: readonly { status: AuditorCallStatus }[],
): AuditorCallStatus {
  return checks.reduce<AuditorCallStatus>(
    (worst, check) => (WORSE[check.status] > WORSE[worst] ? check.status : worst),
    "completed",
  );
}

function judgedInjectionQuotes(
  value: boolean | string[] | undefined,
  reason: string,
): string[] {
  if (value === true) {
    const quote = reason.trim();
    return quote.length > 0 ? [quote] : ["injection attempt"];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

// One quote per distinct instruction: a model asked for every planted
// instruction routinely returns the same one twice in different words.
export function mergePromptInjections(
  judged: boolean | string[] | undefined,
  reason: string,
): PromptInjectionFinding[] {
  const merged: PromptInjectionFinding[] = [];
  const seen: string[] = [];
  for (const quote of judgedInjectionQuotes(judged, reason)) {
    const lower = quote.toLowerCase();
    if (
      seen.some((existing) => existing.includes(lower) || lower.includes(existing))
    ) {
      continue;
    }
    seen.push(lower);
    merged.push({ quote, kind: "model", sourceKind: "model" });
  }
  return merged;
}

export function reportForStep(
  deterministic: DeterministicFindings,
  checks: StepCheckOutcomes,
): StepReport {
  const ran = [
    checks.summary,
    checks.intent,
    checks.injection,
    checks.secrets,
    checks.network,
    checks.tool,
    checks.sinks,
    // flatMap rather than filter: it drops the nulls and narrows the type,
    // where a filter leaves the union with null still in it.
  ].flatMap((check) => (check === null ? [] : [check]));

  const status = worstStatus(ran);
  // Grouped by message rather than listed per check: one unavailable model
  // fails every check with the same words, and printing it once per label
  // turned a single provider error into a paragraph. Naming the question that
  // went unanswered still earns its place when the checks disagree about why.
  // Nothing is lost when it does not: every call keeps its own auditor span,
  // labelled and carrying its own error.
  const failures = new Map<string, string[]>();
  for (const check of ran) {
    if (!check.failure) continue;
    const labels = failures.get(check.failure) ?? [];
    labels.push(check.label);
    failures.set(check.failure, labels);
  }
  const failure =
    [...failures]
      .map(([message, labels]) => {
        if (labels.length === ran.length) return message;
        return labels.join(", ") + ": " + message;
      })
      .join(" · ") || null;

  // Check 1. Detection is deterministic and already done; the check only
  // decides whether each credential belonged in the operation, and a credential
  // it never got to is reported with its relevance unknown rather than dropped.
  const relevanceByType = new Map(
    (checks.secrets?.verdict?.secretRelevance ?? []).map((entry) => [
      entry.secretType,
      entry,
    ]),
  );
  const secretExposures: SecretExposureFinding[] =
    deterministic.secretExposures.map((exposure) => {
      const judged = relevanceByType.get(exposure.secretType);
      return {
        location: exposure.location,
        secretType: exposure.secretType,
        relevant: judged ? judged.relevant : null,
        reason: judged?.reason ?? "",
      };
    });

  // Check 2's second half. A URL is only a destination the step contacted if
  // the check says it was; one quoted in an error message is dropped. A check
  // that did not run, or could not answer, leaves every violation standing —
  // an unreported request is the worse failure.
  const mentionedOnly = new Set(
    (checks.network?.verdict?.calls ?? [])
      .filter((call) => !call.contacted)
      .map((call) => call.url),
  );
  const networkViolations = deterministic.networkViolations.filter(
    (url) => !mentionedOnly.has(url),
  );

  const notInAlignment = checks.intent.verdict?.notInAlignment ?? [];
  const newObjectives = checks.intent.verdict?.newObjectives ?? [];
  const actedOnExternalInstructions =
    checks.injection.verdict?.actedOnExternalInstructions ?? [];
  // AUDIT_PLAN 4.B: an injected *objective* the agent ignored is recorded, not
  // warned about. Acting on it is what earns the intent-check warning.
  const actedOnUnrequested = newObjectives.filter(
    (entry) => !entry.requestedByUser && entry.actedUpon,
  );
  const promptInjections = mergePromptInjections(
    checks.injection.verdict?.promptInjection,
    checks.injection.verdict?.reason ?? "",
  );
  const irrelevantSecrets = secretExposures.filter(
    (entry) => entry.relevant === false,
  );
  // Check 5: the flags themselves, not just that something was off.
  const toolMisuseFlags = checks.tool?.verdict?.misuse
    ? checks.tool.verdict.flags.filter((flag) => flag.trim().length > 0)
    : [];
  // Check 6: what was written, where the check judged it sensitive.
  const sinkWrites = (checks.sinks?.verdict?.writes ?? []).filter(
    (write) => write.sensitive,
  );

  const signals: string[] = [];
  if (notInAlignment.length > 0) signals.push("intent-misalignment");
  if (actedOnUnrequested.length > 0) signals.push("injected-objective");
  if (actedOnExternalInstructions.length > 0) {
    signals.push("acted-on-external-directive");
  }
  if (networkViolations.length > 0) signals.push("network-whitelist-violation");
  if (irrelevantSecrets.length > 0) signals.push("secret-exposure");
  if (deterministic.suspiciousActions.length > 0) signals.push("suspicious-action");
  if (
    deterministic.secretExposures.some((entry) => entry.location === "request")
  ) {
    signals.push("secret-egress");
  }
  if (checks.injection.verdict?.dangerous) signals.push("dangerous-action");
  if (promptInjections.length > 0) signals.push("prompt-injection");
  if (checks.tool?.verdict?.misuse) signals.push("tool-misuse");
  if (sinkWrites.length > 0) signals.push("sink-write");
  if (checks.injection.verdict?.restrictionBypass) {
    signals.push("restriction-bypass");
  }

  const deterministicReason = [
    networkViolations.length > 0
      ? "Contacted " +
        networkViolations.join(", ") +
        " outside the configured whitelist."
      : "",
    irrelevantSecrets.length > 0
      ? "Exposed " +
        irrelevantSecrets.map((entry) => entry.secretType).join(", ") +
        " unrelated to this operation."
      : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return {
    status,
    failure,
    summary: checks.summary.verdict?.summary ?? "",
    policies: {
      notInAlignment,
      newObjectives,
      networkViolations,
      secretExposures,
      promptInjections,
      suspiciousActions: deterministic.suspiciousActions,
      actedOnExternalInstructions,
      toolMisuseFlags,
      sinkWrites,
    },
    tags: signals.filter((signal) => !HAS_ITS_OWN_EMITTER.has(signal)),
    reason: [
      deterministicReason,
      checks.injection.verdict?.reason ?? "",
      failure ?? "",
    ]
      .filter((part) => part.length > 0)
      .join(" · "),
  };
}
