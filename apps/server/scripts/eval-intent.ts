// Measures the Intent Scope Detector against PLAN_INTENT's 56-case dataset.
//
// This is deliberately NOT part of `npm test`: it calls a real model, so it is
// slow, costs tokens, and its result is a score rather than a pass/fail. Run it
// when the prompt changes.
//
//   npm run eval:intent -w @launchpad/server
//
// Accuracy here is in-sample: the prompt was written against these same
// distinctions, so treat the number as a regression signal, not as a
// generalisation estimate.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArkClient } from "../src/ark-client.js";
import { classifyIntent } from "../src/middlewares/intent/intent-classifier.js";

interface IntentCase {
  originalIntent: string;
  extendedIntent: string[];
  message: string;
  expectNewIntent: boolean;
}

const CONCURRENCY = 4;

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
    process.env.AUDIT_INTENT_MODEL?.trim() || "deepseek-v4-flash-ga-260731";
  const client = createArkClient({
    arkBaseUrl: (
      process.env.ARK_BASE_URL?.trim() ||
      "https://ark.cn-beijing.volces.com/api/v3"
    ).replace(/\/+$/, ""),
    arkApiKey: apiKey,
  });

  const fixture = path.join(
    fileURLToPath(new URL("../src/middlewares/intent/__fixtures__/", import.meta.url)),
    "intent-cases.json",
  );
  const cases = JSON.parse(await readFile(fixture, "utf8")) as IntentCase[];
  console.log("Evaluating " + cases.length + " cases against " + model + "\n");

  const results: {
    index: number;
    message: string;
    expected: boolean;
    actual: boolean | null;
    // Whether the classification produced something the reducer would act on.
    // IntentReducer.applyUpdate returns the base spec when a verdict yields no
    // new constraint, no removal and no objective — so an INTENT_UPDATE that
    // extracts nothing is silently a NO_CHANGE, and scoring the label alone
    // counts it as a success.
    effective: boolean | null;
    reason: string;
    attempts: number;
  }[] = [];

  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const entry = cases[index];
      if (!entry) return;
      const state = {
        instructions: "",
        objective: entry.originalIntent,
        extended: entry.extendedIntent,
      };
      const outcome = await classifyIntent(client, model, state, entry.message);
      const verdict = outcome.classification;
      // Mirrors the service's own rule for "did anything change".
      const inForce = new Set(state.extended);
      const effective =
        verdict === null
          ? null
          : verdict.extendedIntent.some(
              (entry) => entry.trim().length > 0 && !inForce.has(entry.trim()),
            ) ||
            verdict.removedIntent.some((candidate) =>
              state.extended.some(
                (existing) =>
                  existing.trim().toLowerCase().replace(/[.\s]+$/, "") ===
                  candidate.trim().toLowerCase().replace(/[.\s]+$/, ""),
              ),
            ) ||
            (verdict.objective !== null &&
              verdict.objective.trim().length > 0 &&
              verdict.objective.trim() !== state.objective);
      results.push({
        index,
        message: entry.message,
        expected: entry.expectNewIntent,
        actual: verdict ? verdict.classification === "INTENT_UPDATE" : null,
        effective,
        reason: outcome.classification?.reason ?? (outcome.failure ?? ""),
        attempts: outcome.attempts,
      });
      process.stdout.write(".");
    }
  });
  await Promise.all(workers);
  results.sort((left, right) => left.index - right.index);
  console.log("\n");

  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let unusable = 0;
  const mismatches: typeof results = [];

  for (const result of results) {
    if (result.actual === null) {
      unusable += 1;
      mismatches.push(result);
      continue;
    }
    if (result.expected && result.actual) truePositive += 1;
    else if (!result.expected && !result.actual) trueNegative += 1;
    else {
      if (result.actual) falsePositive += 1;
      else falseNegative += 1;
      mismatches.push(result);
    }
  }

  const correct = truePositive + trueNegative;
  const pct = (value: number, total: number) =>
    total === 0 ? "n/a" : ((value / total) * 100).toFixed(1) + "%";

  if (mismatches.length > 0) {
    console.log("Mismatches:");
    for (const miss of mismatches) {
      const label =
        miss.actual === null
          ? "UNUSABLE"
          : miss.actual
            ? "said UPDATE, expected NO_CHANGE"
            : "said NO_CHANGE, expected UPDATE";
      console.log("  [" + label + "] " + JSON.stringify(miss.message));
      if (miss.reason) console.log("      reason: " + miss.reason);
    }
    console.log("");
  }

  console.log("Accuracy      " + pct(correct, results.length) +
    " (" + correct + "/" + results.length + ")");
  console.log("Precision     " + pct(truePositive, truePositive + falsePositive) +
    "  (of the messages called INTENT_UPDATE, how many were)");
  console.log("Recall        " + pct(truePositive, truePositive + falseNegative) +
    "  (of the real intent updates, how many were caught)");
  console.log(
    "Confusion     tp=" + truePositive + " fp=" + falsePositive +
      " tn=" + trueNegative + " fn=" + falseNegative +
      " unusable=" + unusable,
  );
  const retried = results.filter((result) => result.attempts > 1).length;
  console.log("Schema retries " + retried + "/" + results.length);

  // Recall above is measured on the label. What governs every later audit is
  // whether the spec actually moved — and a verdict that says INTENT_UPDATE but
  // extracts no constraint, no removal and no objective changes nothing at all.
  // The service returns early on exactly that case, so the two numbers diverging
  // is the measure of how often a "caught" update was caught in name only.
  const realUpdates = results.filter((result) => result.expected);
  const effectivelyCaught = realUpdates.filter(
    (result) => result.effective === true,
  ).length;
  console.log(
    "\nEffective recall " +
      pct(effectivelyCaught, realUpdates.length) +
      "  (of the real intent updates, how many actually changed the spec)",
  );
  const hollow = results.filter(
    (result) => result.actual === true && result.effective === false,
  );
  if (hollow.length > 0) {
    console.log(
      "Called INTENT_UPDATE but extracted nothing actionable (" +
        hollow.length +
        "):",
    );
    for (const entry of hollow) {
      console.log("  " + JSON.stringify(entry.message));
      if (entry.reason) console.log("      reason: " + entry.reason);
    }
  }
  // Scoring the constraint *text* would need expected wording added to the 56
  // fixture cases; today they carry only the binary label, so the closest
  // honest measure is whether anything actionable came out at all.
}

await main();
