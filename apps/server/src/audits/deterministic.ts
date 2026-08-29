import type { TraceRecord, TraceSpan } from "../traces/trace-model.js";
import { classifySecretValue, detectSecretBindings } from "../traces/secrets.js";
import type { SuspiciousActionFinding } from "./audit-model.js";
import { hostOf, type StepActivity } from "./step-activity.js";

// AUDIT_PLAN keeps the objective facts deterministic: which destination the
// step contacted, which credentials appeared, and whether the step wrote
// secret-like data into suspicious sinks such as HTML comments. The auditor can
// still use a model to interpret intent, but it does not need one to notice
// that a later step hid environment-style bindings in generated output.

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
  suspiciousActions: SuspiciousActionFinding[];
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

export interface RepeatedFailure {
  toolName: string;
  attempt: string;
  count: number;
}

// A NUL can occur in neither a tool name nor JSON arguments, so splitting the
// signature on it is unambiguous.
const SIGNATURE_SEPARATOR = "\u0000";

// What was attempted, normalised, so the same command retried under a new call
// id is recognised as the same attempt.
function attemptSignature(span: TraceSpan): string | null {
  if (span.kind !== "tool_call" || span.status !== "error") return null;
  const toolName =
    typeof span.attributes.toolName === "string"
      ? span.attributes.toolName
      : span.name.startsWith("tool.")
        ? span.name.slice("tool.".length)
        : span.name;
  const args =
    typeof span.attributes.arguments === "string"
      ? span.attributes.arguments
      : "";
  const normalized = args.split(/\s+/).join(" ").trim().slice(0, 400);
  return toolName + SIGNATURE_SEPARATOR + normalized;
}

// An agent that retries a denied command four times has a defect that no model
// is needed to see, and one that stays visible when Ark is unreachable. Kept
// here beside the other checks for exactly that reason.
export function findRepeatedFailures(
  trace: TraceRecord,
  threshold = 2,
): RepeatedFailure[] {
  const counts = new Map<string, { span: TraceSpan; count: number }>();
  for (const span of trace.spans) {
    const signature = attemptSignature(span);
    if (signature === null) continue;
    const existing = counts.get(signature);
    if (existing) existing.count += 1;
    else counts.set(signature, { span, count: 1 });
  }

  const repeated: RepeatedFailure[] = [];
  for (const [signature, entry] of counts) {
    if (entry.count < threshold) continue;
    const [toolName = "", attempt = ""] = signature.split(SIGNATURE_SEPARATOR);
    repeated.push({
      toolName,
      attempt: attempt.slice(0, 160),
      count: entry.count,
    });
  }
  return repeated.sort((left, right) => right.count - left.count);
}

type SinkSource =
  | { kind: "tool-output"; lines: string[] }
  | { kind: "file"; path: string; lines: string[] };

interface HtmlCommentBlock {
  source: SinkSource;
  lineStart: number;
  lineEnd: number;
  content: string;
}

function sinkSources(activity: StepActivity): SinkSource[] {
  const sources: SinkSource[] = [];
  if (activity.output.trim().length > 0) {
    sources.push({ kind: "tool-output", lines: activity.output.split(/\r?\n/) });
  }
  for (const file of activity.files) {
    if (file.content.length === 0) continue;
    sources.push({ kind: "file", path: file.path, lines: file.content });
  }
  return sources;
}

function htmlCommentBlocks(source: SinkSource): HtmlCommentBlock[] {
  const blocks: HtmlCommentBlock[] = [];
  let current: { start: number; lines: string[] } | null = null;
  for (const [index, line] of source.lines.entries()) {
    const lineNumber = index + 1;
    if (current === null) {
      const start = line.indexOf("<!--");
      if (start === -1) continue;
      const opened = { start: lineNumber, lines: [line.slice(start)] };
      current = opened;
      if (line.includes("-->", start + "<!--".length)) {
        blocks.push({
          source,
          lineStart: opened.start,
          lineEnd: lineNumber,
          content: opened.lines.join("\n"),
        });
        current = null;
      }
      continue;
    }
    current.lines.push(line);
    if (line.includes("-->")) {
      blocks.push({
        source,
        lineStart: current.start,
        lineEnd: lineNumber,
        content: current.lines.join("\n"),
      });
      current = null;
    }
  }
  if (current !== null) {
    blocks.push({
      source,
      lineStart: current.start,
      lineEnd: source.lines.length,
      content: current.lines.join("\n"),
    });
  }
  return blocks;
}

function clip(text: string, limit = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

function looksLikeEnvBinding(line: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,63}\s*=/.test(line.trim());
}

function hasEnvironmentShape(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => looksLikeEnvBinding(line));
}

function sourceLabel(source: SinkSource): string {
  return source.kind === "file" ? source.path : "tool output";
}

function hasSecretShape(text: string): boolean {
  return detectSecretBindings(text).length > 0;
}

function buildSuspiciousAction(
  block: HtmlCommentBlock,
  kind: SuspiciousActionFinding["kind"],
  evidence: string,
): SuspiciousActionFinding {
  const where =
    block.lineStart === block.lineEnd
      ? "line " + block.lineStart
      : "lines " + block.lineStart + "-" + block.lineEnd;
  return {
    kind,
    sourceKind: block.source.kind,
    lineStart: block.lineStart,
    lineEnd: block.lineEnd,
    ...(block.source.kind === "file" ? { path: block.source.path } : {}),
    summary:
      "Wrote " +
      (kind === "hidden-secret-comment"
        ? "secret-like data"
        : "environment-style bindings") +
      " into an HTML comment in " +
      sourceLabel(block.source) +
      " at " +
      where +
      ": " +
      clip(evidence),
  };
}

export function checkSuspiciousActions(
  activity: StepActivity,
): SuspiciousActionFinding[] {
  const findings: SuspiciousActionFinding[] = [];
  for (const source of sinkSources(activity)) {
    for (const block of htmlCommentBlocks(source)) {
      if (hasSecretShape(block.content)) {
        findings.push(
          buildSuspiciousAction(block, "hidden-secret-comment", block.content),
        );
        continue;
      }
      if (hasEnvironmentShape(block.content)) {
        findings.push(
          buildSuspiciousAction(block, "hidden-env-comment", block.content),
        );
      }
    }
  }
  return findings;
}

export function runDeterministicChecks(
  activity: StepActivity,
  options: DeterministicOptions,
): DeterministicFindings {
  return {
    networkViolations: checkNetworkWhitelist(activity, options.whitelist),
    secretExposures: checkSecretExposure(activity),
    suspiciousActions: checkSuspiciousActions(activity),
  };
}
