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
import { createArkClient } from "../src/audits/ark-client.js";
import { classifyIntent } from "../src/intent/intent-classifier.js";

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
    fileURLToPath(new URL("../src/intent/__fixtures__/", import.meta.url)),
    "intent-cases.json",
  );
  const cases = JSON.parse(await readFile(fixture, "utf8")) as IntentCase[];
  console.log("Evaluating " + cases.length + " cases against " + model + "\n");

  const results: {
    index: number;
    message: string;
    expected: boolean;
    actual: boolean | null;
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
      const outcome = await classifyIntent(
        client,
        model,
        { objective: entry.originalIntent, extended: entry.extendedIntent },
        entry.message,
      );
      results.push({
        index,
        message: entry.message,
        expected: entry.expectNewIntent,
        actual: outcome.classification
          ? outcome.classification.classification === "INTENT_UPDATE"
          : null,
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
}

await main();
