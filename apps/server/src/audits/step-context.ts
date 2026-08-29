import { describeIntent, type IntentState } from "../intent/intent-model.js";
import type { TraceRecord, TraceSpan } from "../traces/trace-model.js";
import type { DeterministicFindings } from "./deterministic.js";
import type { StepActivity } from "./step-activity.js";

// AUDIT_PLAN step 1: establish the trajectory a step sits in without letting
// the step itself be summarised away. Earlier steps are compressed to one line
// each; the step under audit is passed through whole.

const MAX_PRIOR_STEPS = 12;
const PRIOR_STEP_CLIP = 160;
const CURRENT_INPUT_CLIP = 4_000;
const CURRENT_OUTPUT_CLIP = 4_000;

function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + " …[truncated " + (text.length - limit) + " chars]";
}

function oneLine(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}

// Steps worth carrying forward as trajectory: what the agent did, not the
// bookkeeping spans that wrap them.
function isTrajectoryStep(span: TraceSpan) {
  return (
    span.kind === "tool_call" ||
    span.kind === "user_action" ||
    // What the agent said it was going to do belongs in the trajectory as much
    // as what it then did. Without it a tool call arrives with no stated
    // reason, and an objective the agent announced before acting on it was
    // invisible to every step that followed.
    span.kind === "model_call" ||
    // Not emitted today, kept in step with shouldAuditStep so a reinstated
    // subagent span appears in the trajectory as well as being judged.
    (span.kind === "system" && span.name === "subagent.result")
  );
}

export function summarizePriorSteps(
  trace: TraceRecord,
  currentSpanId: string,
): string[] {
  const index = trace.spans.findIndex((span) => span.id === currentSpanId);
  const preceding = (index === -1 ? trace.spans : trace.spans.slice(0, index))
    .filter(isTrajectoryStep)
    .slice(-MAX_PRIOR_STEPS);

  return preceding.map((span) => {
    const parts = ["[" + span.status + "] " + span.label];
    const args = span.attributes.arguments;
    if (typeof args === "string" && args.length > 0) {
      parts.push(oneLine(args, PRIOR_STEP_CLIP));
    }
    // A model call's payload is its output, not its arguments: carrying only
    // the label would put "Model · plan" in the trajectory and none of the plan.
    const output = span.attributes.output;
    if (
      span.kind === "model_call" &&
      typeof output === "string" &&
      output.length > 0
    ) {
      parts.push("said: " + oneLine(output, PRIOR_STEP_CLIP));
    }
    if (span.error) parts.push("error: " + oneLine(span.error, 120));
    return parts.join(" | ");
  });
}

export interface StepContextInput {
  trace: TraceRecord;
  span: TraceSpan;
  intent: IntentState;
  activity: StepActivity;
  deterministic: DeterministicFindings;
  // What the agent inherited from earlier runs on this thread.
  priorContext?: string | undefined;
}

// The user turn of the step audit. Ordered so the specification comes before
// the evidence: the model is judging the step against the intent, not
// summarising the step.
export function buildStepContext(input: StepContextInput): string {
  const { trace, span, intent, activity, deterministic } = input;
  const sections: string[] = [];

  sections.push("## Original user input\n" + (trace.prompt || "(none)"));
  // Instructions are part of the intent state itself, so describeIntent renders
  // them alongside the objective they are the source of truth for.
  sections.push("## Current intent\n" + describeIntent(intent));
  // A step that looks unmotivated in isolation is often finishing something an
  // earlier run started, so withholding this made the auditor over-flag.
  if (input.priorContext && input.priorContext.length > 0) {
    sections.push("## Carried in from previous runs\n" + input.priorContext);
  }

  const prior = summarizePriorSteps(trace, span.id);
  sections.push(
    "## Trajectory so far\n" +
      (prior.length > 0
        ? prior.map((line) => "- " + line).join("\n")
        : "(this is the first step)"),
  );

  const step: string[] = [
    "Kind: " + span.kind,
    "Name: " + span.name,
    "Label: " + span.label,
    "Status: " + span.status,
  ];
  if (activity.commands.length > 0) {
    step.push("Commands: " + activity.commands.join(" ; "));
  }
  if (activity.files.length > 0) {
    step.push("Files touched: " + activity.files.map((f) => f.path).join(", "));
  }
  if (activity.servicesInteracted.length > 0) {
    step.push("Services contacted: " + activity.servicesInteracted.join(", "));
  }
  if (activity.input) {
    step.push("Input:\n" + clip(activity.input, CURRENT_INPUT_CLIP));
  }
  if (activity.output) {
    step.push("Output:\n" + clip(activity.output, CURRENT_OUTPUT_CLIP));
  }
  if (span.error) step.push("Error: " + span.error);
  sections.push("## Step under audit\n" + step.join("\n"));

  const observed: string[] = [];
  if (deterministic.networkViolations.length > 0) {
    observed.push(
      "Destinations outside the configured whitelist: " +
        deterministic.networkViolations.join(", "),
    );
  }
  if (deterministic.secretExposures.length > 0) {
    observed.push(
      "Credentials present (values already masked): " +
        deterministic.secretExposures
          .map(
            (entry) =>
              entry.secretType +
              (entry.location === "request"
                ? " (sent outward)"
                : " (received)"),
          )
          .join(", "),
    );
  }
  if (observed.length > 0) {
    sections.push(
      "## Already established (do not re-derive)\n" +
        observed.map((line) => "- " + line).join("\n"),
    );
  }

  return sections.join("\n\n");
}
