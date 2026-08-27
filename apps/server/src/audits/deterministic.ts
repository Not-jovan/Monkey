import { classifySecretValue, detectSecretBindings } from "../traces/secrets.js";
import { hostOf, type StepActivity } from "./step-activity.js";

// AUDIT_PLAN calls for these two checks to be deterministic rather than
// judged: a model is never asked whether a host is on a list, nor whether a
// credential is present. Only relevance (does this secret belong in this
// operation) stays a judged question, handled by the audit model.

export type SecretLocation = "request" | "response";

export interface SecretExposure {
  location: SecretLocation;
  secretType: string;
  // The masked value, kept so an operator can correlate which credential
  // leaked without the plaintext being re-persisted.
  hint: string;
}

export interface DeterministicFindings {
  networkViolations: string[];
  secretExposures: SecretExposure[];
}

export interface DeterministicOptions {
  // null disables the check entirely, per AUDIT_PLAN "if Config.whitelist !== null".
  whitelist: string[] | null;
}

function maskHint(value: string) {
  if (value.length >= 12) {
    return value.slice(0, 3) + "…" + value.slice(-3);
  }
  return "******";
}

// Exact host match, with a leading dot opting a whole subtree in
// (".github.com" covers api.github.com; "github.com" alone does not).
function isWhitelisted(host: string, whitelist: string[]) {
  return whitelist.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (normalized.startsWith(".")) {
      return host === normalized.slice(1) || host.endsWith(normalized);
    }
    return host === normalized;
  });
}

export function checkNetworkWhitelist(
  activity: StepActivity,
  whitelist: string[] | null,
): string[] {
  // Loose equality on purpose: an absent whitelist and an explicit null both
  // mean "check disabled", and test doubles routinely pass neither.
  if (whitelist == null) return [];
  const violations: string[] = [];
  for (const call of activity.networkCalls) {
    const host = hostOf(call.url);
    if (host === null || !isWhitelisted(host, whitelist)) {
      violations.push(call.url);
    }
  }
  return violations;
}

export function checkSecretExposure(activity: StepActivity): SecretExposure[] {
  // Credentials the step had in hand, named by the variable they were bound to.
  const bindings = new Map<string, string>();
  const remember = (secretType: string, value: string) => {
    if (!bindings.has(secretType)) bindings.set(secretType, value);
  };
  for (const file of activity.files) {
    for (const binding of detectSecretBindings(file.content.join("\n"))) {
      remember(binding.secretType, binding.value);
    }
  }
  for (const call of activity.networkCalls) {
    for (const text of [call.request ?? "", call.response ?? ""]) {
      for (const binding of detectSecretBindings(text)) {
        remember(binding.secretType, binding.value);
      }
    }
  }

  const requestText = activity.networkCalls
    .map((call) => call.request ?? "")
    .join("\n");
  const responseText = activity.networkCalls
    .map((call) => call.response ?? "")
    .join("\n");

  // Names carried over from pre-redaction detection. Egress wins over ingress
  // when the same credential was seen on both sides.
  const declared = new Map<string, SecretLocation>();
  for (const entry of activity.declaredSecrets) {
    if (entry.location === "request" || !declared.has(entry.secretType)) {
      declared.set(entry.secretType, entry.location);
    }
  }

  const exposures: SecretExposure[] = [];
  for (const [secretType, value] of bindings) {
    // Egress wins: a credential that left the system is reported once, as a
    // request, even though the step also read it from disk.
    const sentOutward =
      requestText.includes(value) ||
      classifySecretValue(requestText) === secretType;
    const location: SecretLocation = sentOutward ? "request" : "response";
    if (
      !sentOutward &&
      !responseText.includes(value) &&
      activity.files.length === 0
    ) {
      // Never observed anywhere durable — nothing to report.
      continue;
    }
    const declaredLocation = declared.get(secretType);
    declared.delete(secretType);
    exposures.push({
      location: declaredLocation === "request" ? "request" : location,
      secretType,
      hint: maskHint(value),
    });
  }
  // Credentials whose value redaction already masked beyond recognition are
  // still reported by name.
  for (const [secretType, location] of declared) {
    exposures.push({ location, secretType, hint: "******" });
  }
  return exposures;
}

export function runDeterministicChecks(
  activity: StepActivity,
  options: DeterministicOptions,
): DeterministicFindings {
  return {
    networkViolations: checkNetworkWhitelist(activity, options.whitelist),
    secretExposures: checkSecretExposure(activity),
  };
}
