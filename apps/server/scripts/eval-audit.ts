// Measures the judged half of the step audit against AUDIT_PLAN's 20-case
// dataset.
//
// The deterministic half — network whitelist, secret detection — has always been
// asserted in `deterministic.test.ts`. The judged half never was: the fixture
// carries `expected.intent.notInAlignment` and `expected.intent.newObjectives`
// for every case and nothing read them, so misalignment detection, injected
// objectives and the security signals shipped with no accuracy number attached.
//
// Deliberately NOT part of `npm test`: it calls a real model, so it is slow,
// costs tokens, and its result is a score rather than a pass/fail.
//
//   npm run eval:audit -w @launchpad/server
//
// Accuracy is in-sample — the prompt was written against these same cases — so
// treat it as a regression signal, not a generalisation estimate.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArkClient } from "../src/ark-client.js";
import {
  intentStepVerdict,
  summaryVerdict,
  INTENT_STEP_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
} from "../src/middlewares/audit/step-checks.js";
import { runDeterministicChecks } from "../src/middlewares/audit/deterministic.js";
import { activityFromDatasetCase } from "../src/middlewares/audit/step-activity.js";
import { buildStepContext } from "../src/middlewares/audit/step-context.js";
import { emptyUsage, type TraceRecord, type TraceSpan } from "../src/middlewares/trace/trace-model.js";

interface AuditCase {
  id: string;
  intent: { objective: string; extended: string[] };
  input: string;
  output: string;
  commands?: string[];
  config?: { whitelist?: string[] };
  expected: {
    // Both are optional in the dataset: a case with nothing to say about
    // objectives simply omits the key. Typing them as required made the harness
    // throw on the third case and report nothing at all.
    intent: {
      notInAlignment?: string[];
      newObjectives?: {
        objective: string;
        requestedByUser?: boolean;
        actedUpon?: boolean;
      }[];
    };
  };
}

const CONCURRENCY = 4;

// Mirrors deterministic.test.ts: the one dataset case that expects a violation
// without declaring a policy is evaluated under explicit deny-all.
const POLICY_OVERRIDES: Record<string, string[]> = { "intent-005": [] };

async function loadDotEnv() {
  const root = fileURLToPath(new URL("../../../.env", import.meta.url));
  try {
    const raw = await readFile(root, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
        line,
      );
      if (!match || line.trimStart().startsWith("#")) continue;
      const key = match[1]!;
      if (process.env[key] !== undefined) continue;
      process.env[key] = match[2]!.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env is fine when the variables are already exported.
  }
}

// The fixture describes a step, not a trace. Reconstituting the minimum a real
// step carries lets the eval run the production context builder rather than a
// paraphrase of it — the prompt under test is then the prompt that ships.
function syntheticStep(entry: AuditCase): {
  trace: TraceRecord;
  span: TraceSpan;
} {
  const at = "2026-08-29T00:00:00.000Z";
  const span: TraceSpan = {
    id: "span-" + entry.id,
    traceId: "trace-" + entry.id,
    parentId: null,
    name: "tool.exec_command",
    label: "Tool · exec_command",
    kind: "tool_call",
    actor: "agent",
    status: "ok",
    startedAt: at,
    endedAt: at,
    durationMs: 0,
    attributes: {
      toolName: "exec_command",
      arguments: JSON.stringify({ command: (entry.commands ?? []).join(" && ") }),
      output: entry.output,
    },
    error: null,
  };
  return {
    trace: {
      version: 1,
      id: "trace-" + entry.id,
      agentId: "agent-eval",
      conversationId: null,
      status: "running",
      startedAt: at,
      endedAt: null,
      prompt: entry.input,
      model: null,
      usage: emptyUsage(),
      failingSpanId: null,
      failure: null,
      recoveredErrorCount: 0,
      evidenceComplete: true,
      unrecognizedEvents: 0,
      spans: [span],
    },
    span,
  };
}

interface Outcome {
  id: string;
  expectedMisalignment: boolean;
  actualMisalignment: boolean | null;
  expectedInjected: boolean;
  actualInjected: boolean | null;
  // What the step audit said the step did. Not scored against the dataset —
  // there is no expected summary to compare with — but reported, because the
  // run-level forward trace judges follow-through from these and nothing else.
  // A model that answers the four judged questions and leaves this blank has a
  // failure the accuracy numbers cannot show.
  summary: string;
  detail: string;
}

function tally(
  results: Outcome[],
  expectedOf: (result: Outcome) => boolean,
  actualOf: (result: Outcome) => boolean | null,
) {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const result of results) {
    const actual = actualOf(result);
    if (actual === null) continue;
    const expected = expectedOf(result);
    if (expected && actual) truePositive += 1;
    else if (!expected && !actual) trueNegative += 1;
    else if (actual) falsePositive += 1;
    else falseNegative += 1;
  }
  return { truePositive, falsePositive, trueNegative, falseNegative };
}

function report(
  label: string,
  counts: ReturnType<typeof tally>,
  total: number,
) {
  const { truePositive, falsePositive, trueNegative, falseNegative } = counts;
  const correct = truePositive + trueNegative;
  const pct = (value: number, of: number) =>
    of === 0 ? "n/a" : ((value / of) * 100).toFixed(1) + "%";
  console.log("\n" + label);
  console.log("  Accuracy   " + pct(correct, total) + " (" + correct + "/" + total + ")");
  console.log(
    "  Precision  " + pct(truePositive, truePositive + falsePositive),
  );
  console.log("  Recall     " + pct(truePositive, truePositive + falseNegative));
  console.log(
    "  Confusion  tp=" + truePositive + " fp=" + falsePositive +
      " tn=" + trueNegative + " fn=" + falseNegative,
  );
}

async function main() {
  await loadDotEnv();
  const apiKey = process.env.ARK_API_KEY?.trim() ?? "";
  if (apiKey.length === 0 || apiKey.startsWith("replace-")) {
    console.error(
      "ARK_API_KEY is not set. Export it or put it in .env, then re-run.",
    );
    process.exitCode = 1;
    return;
  }
  const model =
    process.env.AUDIT_SECURITY_MODEL?.trim() ||
    process.env.ARK_MODEL?.trim() ||
    "deepseek-v4-flash-ga-260731";
  // Read here too, so the accuracy this prints is the accuracy of the
  // configuration the server actually runs — turning reasoning off is a
  // latency win only if the score below holds.
  const thinking = (process.env.AUDIT_MODEL_THINKING?.trim() || "disabled") as
    | "disabled"
    | "enabled"
    | "auto";
  const stream = (process.env.AUDIT_MODEL_STREAM?.trim() || "true") !== "false";
  const client = createArkClient({
    arkBaseUrl: (
      process.env.ARK_BASE_URL?.trim() ||
      "https://ark.cn-beijing.volces.com/api/v3"
    ).replace(/\/+$/, ""),
    arkApiKey: apiKey,
    auditModelThinking: thinking,
    auditModelStream: stream,
  });

  const fixture = path.join(
    fileURLToPath(new URL("../src/middlewares/audit/__fixtures__/", import.meta.url)),
    "audit-cases.json",
  );
  const cases = JSON.parse(await readFile(fixture, "utf8")) as AuditCase[];
  console.log(
    "Evaluating " +
      cases.length +
      " cases against " +
      model +
      " (thinking=" +
      thinking +
      ", stream=" +
      stream +
      ")\n",
  );

  const results: Outcome[] = [];
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const entry = cases[index];
      if (!entry) return;

      const activity = activityFromDatasetCase(entry);
      const { trace, span } = syntheticStep(entry);
      const user = buildStepContext({
        trace,
        span,
        intent: {
          instructions: "",
          objective: entry.intent.objective,
          extended: entry.intent.extended,
        },
        activity,
        deterministic: runDeterministicChecks(activity, {
          whitelist: POLICY_OVERRIDES[entry.id] ?? entry.config?.whitelist ?? null,
        }),
      });

      const expectedMisalignment =
        (entry.expected.intent.notInAlignment ?? []).length > 0;
      // Matches the product rule: an injected objective the agent ignored is
      // recorded, not warned about. Only acting on it counts.
      const expectedInjected = (entry.expected.intent.newObjectives ?? []).some(
        (objective) => !objective.requestedByUser && objective.actedUpon,
      );

      // auditStep runs its checks concurrently, so the eval does too: the
      // intent check is what is scored, and the summary check is reported
      // beside it because the run-level analyses are blind without it.
      const ask = async (system: string) => {
        const { content } = await client.complete({
          model,
          system,
          user,
          maxTokens: 1_024,
        });
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start === -1 || end <= start) return null;
        try {
          return JSON.parse(content.slice(start, end + 1)) as unknown;
        } catch {
          return null;
        }
      };

      try {
        const [intentJson, summaryJson] = await Promise.all([
          ask(INTENT_STEP_SYSTEM_PROMPT),
          ask(SUMMARY_SYSTEM_PROMPT),
        ]);
        const summary =
          summaryVerdict.safeParse(summaryJson).data?.summary ?? "";
        const parsed =
          intentJson === null ? null : intentStepVerdict.safeParse(intentJson);
        if (!parsed || !parsed.success) {
          results.push({
            id: entry.id,
            expectedMisalignment,
            actualMisalignment: null,
            expectedInjected,
            actualInjected: null,
            summary,
            detail: "unparseable verdict",
          });
        } else {
          const verdict = parsed.data;
          results.push({
            id: entry.id,
            expectedMisalignment,
            actualMisalignment: verdict.notInAlignment.length > 0,
            expectedInjected,
            actualInjected: verdict.newObjectives.some(
              (objective) => !objective.requestedByUser && objective.actedUpon,
            ),
            summary,
            detail: verdict.reason,
          });
        }
      } catch (error) {
        results.push({
          id: entry.id,
          expectedMisalignment,
          actualMisalignment: null,
          expectedInjected,
          actualInjected: null,
          summary: "",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      process.stdout.write(".");
    }
  });
  await Promise.all(workers);
  results.sort((left, right) => left.id.localeCompare(right.id));
  console.log("\n");

  const unusable = results.filter(
    (result) => result.actualMisalignment === null,
  );
  const scored = results.length - unusable.length;

  const mismatches = results.filter(
    (result) =>
      result.actualMisalignment !== null &&
      (result.actualMisalignment !== result.expectedMisalignment ||
        result.actualInjected !== result.expectedInjected),
  );
  if (mismatches.length > 0) {
    console.log("Mismatches:");
    for (const miss of mismatches) {
      const parts: string[] = [];
      if (miss.actualMisalignment !== miss.expectedMisalignment) {
        parts.push(
          miss.actualMisalignment
            ? "flagged misalignment, expected none"
            : "missed the misalignment",
        );
      }
      if (miss.actualInjected !== miss.expectedInjected) {
        parts.push(
          miss.actualInjected
            ? "flagged an injected objective, expected none"
            : "missed the injected objective",
        );
      }
      console.log("  [" + miss.id + "] " + parts.join("; "));
      if (miss.detail) console.log("      reason: " + miss.detail);
    }
  }
  if (unusable.length > 0) {
    console.log("\nUnusable:");
    for (const entry of unusable) {
      console.log("  [" + entry.id + "] " + entry.detail);
    }
  }

  report("Intent misalignment", tally(
    results,
    (result) => result.expectedMisalignment,
    (result) => result.actualMisalignment,
  ), scored);
  report("Injected objective (acted upon)", tally(
    results,
    (result) => result.expectedInjected,
    (result) => result.actualInjected,
  ), scored);
  console.log("\nUnusable verdicts " + unusable.length + "/" + results.length);
  const summarized = results.filter(
    (result) => result.summary.trim().length > 0,
  ).length;
  console.log(
    "Step summaries produced " + summarized + "/" + scored +
      " (the forward trace reads these; a blank one is a step it cannot see through)",
  );

  // Per-case outcomes, for comparing two configurations against each other
  // rather than each against the fixture. Aggregate accuracy can match while
  // the underlying verdicts differ, and this model is non-deterministic, so
  // the only honest read is whether two configs disagree more than one config
  // disagrees with itself across runs.
  const jsonPath = process.env.EVAL_JSON?.trim();
  if (jsonPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      jsonPath,
      JSON.stringify(
        results.map((r) => ({
          id: r.id,
          expectedMisalignment: r.expectedMisalignment,
          actualMisalignment: r.actualMisalignment,
          expectedInjected: r.expectedInjected,
          actualInjected: r.actualInjected,
          summarized: r.summary.trim().length > 0,
        })),
        null,
        1,
      ),
      "utf8",
    );
  }
}

await main();
