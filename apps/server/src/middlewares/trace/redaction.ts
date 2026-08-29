import { globalSecretValuePatterns } from "./secrets.js";

// GitLab-style masking: values of known secret variables are replaced wherever
// they appear in trace/audit payloads. Long secrets keep the first and last 3
// characters so operators can still correlate which credential leaked
// (abcdef123456789xyz -> abc************xyz); short secrets are fully masked
// because a partial reveal would give away too much of them.
const PARTIAL_REVEAL_MIN_LENGTH = 12;
const FULL_MASK = "******";

// Value-based masking only works for secrets we know about. The shapes come
// from the same table the audit pipeline detects against, so a credential the
// auditor can name is a credential the redactor can mask. The Bearer rule is
// local because it keeps the scheme readable via its capture groups.
const secretPatterns = [
  ...globalSecretValuePatterns(),
  /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}={0,2})/g,
];

export function maskSecret(value: string) {
  if (value.length >= PARTIAL_REVEAL_MIN_LENGTH) {
    return (
      value.slice(0, 3) + "*".repeat(value.length - 6) + value.slice(-3)
    );
  }
  return FULL_MASK;
}

// GitLab only masks variables that are single-line and long enough to be a
// real credential; anything else would mangle ordinary words like "true".
function isMaskable(value: string) {
  return value.length >= 8 && !/[\r\n]/.test(value);
}

export function createRedactor(secretValues: string[]) {
  const secrets = [...new Set(secretValues.filter(isMaskable))].sort(
    (left, right) => right.length - left.length,
  );

  const redactText = (text: string) => {
    let result = text;
    for (const secret of secrets) {
      result = result.split(secret).join(maskSecret(secret));
    }
    for (const pattern of secretPatterns) {
      result = result.replace(pattern, (match, prefix?: string, token?: string) => {
        if (typeof prefix === "string" && typeof token === "string") {
          return prefix + maskSecret(token);
        }
        return maskSecret(match);
      });
    }
    return result;
  };

  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      return redactText(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]),
      );
    }
    return value;
  };

  return {
    redactText,
    // Structured clones stay JSON-compatible: only strings are rewritten.
    redactDeep: <T>(value: T) => redactValue(value) as T,
  };
}

export type Redactor = ReturnType<typeof createRedactor>;
