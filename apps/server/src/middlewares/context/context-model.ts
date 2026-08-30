import { z } from "zod";
import { activityFromSpan } from "../audit/step-activity.js";
import type { TraceRecord } from "../trace/trace-model.js";

// What one run leaves behind for the next.
//
// Prior context used to exist only when the run-level audit model answered:
// `contextSummary` was `verdict?.context_summary ?? ""`, so a model outage, a
// disabled auditor, or an unactivated endpoint left the chain silently empty
// and every later run was judged as if nothing had happened before it. The
// digest below is derived from the trace alone, so a run always leaves
// something behind. The auditor used to overlay a model compression on top;
// that whole-run diagnosis is gone, so the digest is the only source.

export const runDigestSchema = z.object({
  prompt: z.string(),
  outcome: z.string(),
  filesTouched: z.array(z.string()),
  commands: z.array(z.string()),
  services: z.array(z.string()),
  failureKind: z.string().nullable(),
  failureLayer: z.string().nullable(),
});

export type RunDigest = z.infer<typeof runDigestSchema>;

export const runContextSchema = z.object({
  version: z.literal(1),
  traceId: z.string(),
  agentId: z.string(),
  conversationId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  summary: z.string(),
  // "derived" means the digest below produced it without a model. Shown in the
  // UI, because a reader should know which one they are reading.
  source: z.enum(["derived", "model"]),
  digest: runDigestSchema,
});

export type RunContext = z.infer<typeof runContextSchema>;

const MAX_LISTED = 6;
const MAX_SUMMARY = 600;

function unique(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function list(values: string[]) {
  const kept = values.slice(0, MAX_LISTED);
  const rest = values.length - kept.length;
  return kept.join(", ") + (rest > 0 ? " (+" + rest + " more)" : "");
}

export function buildRunDigest(trace: TraceRecord): RunDigest {
  const files: string[] = [];
  const commands: string[] = [];
  const services: string[] = [];

  // Reuses the extraction the auditor already trusts rather than parsing spans
  // a second way, so the digest and the audit can never disagree about what a
  // run touched.
  for (const span of trace.spans) {
    if (span.kind !== "tool_call") continue;
    const activity = activityFromSpan(span, trace);
    for (const file of activity.files) files.push(file.path);
    for (const command of activity.commands) commands.push(command);
    for (const service of activity.servicesInteracted) services.push(service);
  }

  return {
    prompt: trace.prompt,
    outcome: trace.status,
    filesTouched: unique(files),
    commands: unique(commands),
    services: unique(services),
    failureKind: trace.failure?.kind ?? null,
    failureLayer: trace.failure?.layer ?? null,
  };
}

// The deterministic carry-forward. Deliberately plain: it is read by the next
// run's auditor and by a person, and both are better served by facts than by
// prose a model might have written.
export function describeDigest(digest: RunDigest): string {
  // A run can complete and still have hit a wall — the agent worked around a
  // denial rather than being stopped by it. Saying "completed (sandbox-denied)"
  // would read as a contradiction, so the two are worded apart.
  const attribution = digest.failureKind
    ? (digest.outcome === "completed" ? ", recovered from " : ", ") +
      digest.failureLayer +
      " · " +
      digest.failureKind
    : "";
  const parts = [
    "Asked to: " + (digest.prompt || "(no prompt recorded)"),
    "Outcome: " + digest.outcome + attribution,
  ];
  if (digest.filesTouched.length > 0) {
    parts.push("Files: " + list(digest.filesTouched));
  }
  if (digest.commands.length > 0) {
    parts.push("Commands: " + list(digest.commands));
  }
  if (digest.services.length > 0) {
    parts.push("Contacted: " + list(digest.services));
  }
  const text = parts.join(". ");
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) + "…" : text;
}
