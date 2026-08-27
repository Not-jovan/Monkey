import type { TraceSpan } from "../types";

export interface StepDetailOptions {
  tracePrompt?: string;
  spans?: TraceSpan[];
}

function formatJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function findLatestToolSpan(
  spans: TraceSpan[],
  toolName: string | undefined,
  beforeStartedAt: string,
) {
  if (!toolName) return null;
  return spans
    .filter(
      (candidate) =>
        candidate.kind === "tool_call" &&
        candidate.attributes.toolName === toolName &&
        candidate.startedAt < beforeStartedAt,
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}

function storedText(value: string | number | boolean | undefined) {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

export function stepContext(
  span: TraceSpan,
  options: StepDetailOptions = {},
): string | null {
  const spans = options.spans ?? [];
  const tracePrompt = options.tracePrompt;

  if (span.name === "user.prompt" || span.name === "user.intervention") {
    return storedText(span.attributes.prompt) ?? tracePrompt ?? null;
  }

  if (span.kind === "model_call") {
    const stored = storedText(span.attributes.context);
    const output = storedText(span.attributes.output);
    if (stored && (output || !span.label.includes("reply"))) {
      return stored;
    }

    if (span.attributes.phase === "plan") {
      if (tracePrompt) return tracePrompt;
      return storedText(span.attributes.prompt);
    }

    if (span.attributes.phase === "after_tool") {
      const afterTool =
        typeof span.attributes.afterTool === "string"
          ? span.attributes.afterTool
          : undefined;
      const toolSpan = findLatestToolSpan(spans, afterTool, span.startedAt);
      return storedText(toolSpan?.attributes.output);
    }

    return null;
  }

  if (span.kind === "tool_call") {
    const args = storedText(span.attributes.arguments);
    if (args) return formatJson(args);
    return storedText(span.attributes.prompt);
  }

  if (span.name === "subagent.result") {
    const parent = spans.find((candidate) => candidate.id === span.parentId);
    const parentArgs = storedText(parent?.attributes.arguments);
    if (parentArgs) return formatJson(parentArgs);
    return null;
  }

  return storedText(span.attributes.prompt);
}

export function stepReturn(
  span: TraceSpan,
  options: StepDetailOptions = {},
): string | null {
  const spans = options.spans ?? [];

  if (span.name === "subagent.result") {
    const result = storedText(span.attributes.result);
    if (!result) return null;
    return formatJson(result);
  }

  if (span.kind === "tool_call") {
    return storedText(span.attributes.output);
  }

  if (span.kind === "model_call") {
    const output = storedText(span.attributes.output);
    if (output) return output;
    // Older traces stuffed the assistant reply into context on the last model span.
    if (span.label.includes("reply")) {
      return storedText(span.attributes.context);
    }
    return null;
  }

  const output = storedText(span.attributes.output);
  if (output) return output;
  const result = storedText(span.attributes.result);
  if (result) return formatJson(result);
  return null;
}

export function stepReturnNote(span: TraceSpan): string | null {
  if (span.name === "subagent.result" && span.attributes.synthesized === true) {
    return "Synthesized from exec_command output (not a native Codex subagent span).";
  }
  return null;
}
