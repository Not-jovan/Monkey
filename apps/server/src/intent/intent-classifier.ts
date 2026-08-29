import { z } from "zod";
import type { ArkClient } from "../audits/ark-client.js";
import type { IntentState } from "./intent-model.js";

export const intentClassification = z.object({
  classification: z.enum(["NO_CHANGE", "INTENT_UPDATE"]),
  reason: z.string().default(""),
  extendedIntent: z.array(z.string()).default([]),
  // The prompt has always asked the model to treat "actually, you can read
  // .env now" as an update, but there was no field in which to say what was
  // relaxed. The only expressible answer was to append the permission next to
  // the prohibition and hand the auditor a spec contradicting itself.
  removedIntent: z.array(z.string()).default([]),
  // Not in PLAN_INTENT's output block. Without it a full pivot ("Forget the
  // todo app, I want a calendar") leaves the objective stale forever and every
  // later audit compares against a goal the user abandoned. Optional, so a
  // model that omits it still validates.
  objective: z.string().nullable().default(null),
});

export type IntentClassification = z.infer<typeof intentClassification>;

// Follows PLAN_INTENT's Intent Scope Detector, with one correction: the plan's
// example block lists "Use PostgreSQL instead of SQLite." as INTENT_UPDATE
// while its own test dataset labels that exact sentence NO_CHANGE. The dataset
// is the acceptance oracle and is self-consistent, so the rule below follows
// it — the discriminator is whether the message marks itself as durable, not
// whether it names a technology.
const SYSTEM_PROMPT = [
  "You are an Intent Scope Detector.",
  "",
  "Your job is to determine whether the user's latest message changes the",
  "specification that should govern the agent's future behavior.",
  "",
  "You are NOT responsible for deciding whether the user's request is",
  "malicious, safe, or appropriate. You are NOT responsible for executing it.",
  "",
  "## The distinction",
  "",
  "A request to perform work is NOT an intent update merely because it adds",
  "new work. An intent update occurs when the message changes the rules,",
  "boundaries, requirements, preferences, or objective against which future",
  "agent behavior should be evaluated.",
  "",
  "Classify as INTENT_UPDATE when the message:",
  "- prohibits or restricts something (\"do not\", \"never\", \"don't\", \"avoid\"),",
  "  including softened forms (\"try not to\", \"can you avoid\", \"where possible\")",
  "- limits scope (\"only modify src/\", \"X is out of scope\", \"don't touch Y\")",
  "- marks itself as durable (\"from now on\", \"all new code\", \"for this",
  "  project\", \"the app must\", \"should never\")",
  "- states a standing preference (\"I'd prefer X over Y\")",
  "- states a conditional rule (\"if you need X, use Y\")",
  "- relaxes an existing constraint (\"actually, you can read .env now\")",
  "- changes the objective (\"actually, build a notes app instead\")",
  "",
  "Classify as NO_CHANGE when the message:",
  "- asks for work that pursues the existing objective (\"build the UI\",",
  "  \"add tests\", \"fix the delete button\", \"add dark mode\")",
  "- picks a technology for the task at hand without marking it as a standing",
  "  rule (\"use TypeScript\", \"use Tailwind for the UI\",",
  "  \"use PostgreSQL instead of SQLite\")",
  "- merely muses or suggests (\"maybe use Redis for caching\")",
  "- asks a question seeking information rather than a behavior change",
  "  (\"should we use PostgreSQL?\", \"why are you using so many abstractions?\")",
  "",
  "A question that also demands a change is an update:",
  "\"Why are you using any? Don't use it.\" -> INTENT_UPDATE.",
  "",
  "## Output",
  "",
  "Return JSON only:",
  '{"classification":"NO_CHANGE"|"INTENT_UPDATE","reason":"short explanation",',
  '"extendedIntent":["only newly introduced constraints, requirements,',
  ' preferences, or scope changes"],',
  '"removedIntent":["constraints listed under Current Extended Intent that this',
  ' message lifts, copied verbatim"],"objective":null}',
  "",
  "When the message relaxes or cancels a rule already in force, copy that rule",
  "into removedIntent exactly as it appears under Current Extended Intent.",
  "Never express a relaxation by adding its opposite to extendedIntent: a spec",
  "holding both a prohibition and its permission cannot be enforced.",
  "",
  "If classification is NO_CHANGE, extendedIntent must be an empty array.",
  "Set objective to the new goal only when the user replaces the objective",
  "outright; otherwise null.",
  "Write each extendedIntent entry as a standalone rule that still makes sense",
  "with no surrounding conversation.",
].join("\n");

function buildUserMessage(state: IntentState, message: string) {
  return [
    "## Original Intent",
    state.objective || "(none stated)",
    "",
    "## Current Extended Intent",
    state.extended.length > 0
      ? state.extended.map((entry) => "- " + entry).join("\n")
      : "(none)",
    "",
    "## New User Message",
    message,
  ].join("\n");
}

function extractJson(content: string) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export interface ClassifyResult {
  classification: IntentClassification | null;
  attempts: number;
  failure: string | null;
}

const MAX_ATTEMPTS = 3;

// PLAN_INTENT: "Validate with zod, if its wrong, prompt the agent and try
// again. Retry max 3 times." The correction is appended to the user turn
// because the Ark client is single-shot.
export async function classifyIntent(
  client: ArkClient,
  model: string,
  state: IntentState,
  message: string,
): Promise<ClassifyResult> {
  const base = buildUserMessage(state, message);
  let correction = "";
  let failure: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const { content } = await client.complete({
        model,
        system: SYSTEM_PROMPT,
        user: correction ? base + "\n\n" + correction : base,
        maxTokens: 512,
      });
      const parsed = intentClassification.safeParse(extractJson(content));
      if (parsed.success) {
        const value = parsed.data;
        // The plan requires NO_CHANGE to carry an empty list; enforce it here
        // rather than trusting the model to remember.
        if (value.classification === "NO_CHANGE") {
          return {
            classification: {
              ...value,
              extendedIntent: [],
              removedIntent: [],
              objective: null,
            },
            attempts: attempt,
            failure: null,
          };
        }
        return { classification: value, attempts: attempt, failure: null };
      }
      failure = parsed.error.issues
        .map((issue) => issue.path.join(".") + " " + issue.message)
        .join("; ");
      correction =
        "Your previous reply did not match the required schema (" +
        failure +
        "). Reply with JSON only, matching the schema exactly.";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      correction =
        "Your previous reply could not be read. Reply with JSON only, " +
        "matching the schema exactly.";
    }
  }

  return { classification: null, attempts: MAX_ATTEMPTS, failure };
}
