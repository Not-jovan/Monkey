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

export function stepContext(
  span: TraceSpan,
  options: StepDetailOptions = {},
): string | null {
  const spans = options.spans ?? [];
  const tracePrompt = options.tracePrompt;

  if (span.name === "user.prompt" || span.name === "user.intervention") {
    const prompt =
      (typeof span.attributes.prompt === "string" ? span.attributes.prompt : null) ??
      tracePrompt;
    return prompt;
  }

  if (span.kind === "model_call") {
    const phase = span.attributes.phase;
    const stored = span.attributes.context;

    if (phase === "plan") {
      return (
        (typeof stored === "string" && stored.length > 0 ? stored : null) ??
        tracePrompt ??
        (typeof span.attributes.prompt === "string" ? span.attributes.prompt : null)
      );
    }

    if (phase === "after_tool") {
      const afterTool =
        typeof span.attributes.afterTool === "string"
          ? span.attributes.afterTool
          : undefined;
      const toolSpan = findLatestToolSpan(spans, afterTool, span.startedAt);
      if (typeof toolSpan?.attributes.output === "string") {
        return toolSpan.attributes.output;
      }
      if (typeof stored === "string" && stored.length > 0 && !span.label.includes("reply")) {
        return stored;
      }
    }

    return null;
  }

  if (span.kind === "tool_call") {
    const args = span.attributes.arguments;
    if (typeof args === "string" && args.length > 0) {
      return formatJson(args);
    }
    const prompt = span.attributes.prompt;
    if (typeof prompt === "string" && prompt.length > 0) {
      return prompt;
    }
    return null;
  }

  if (span.name === "subagent.result") {
    const parent = spans.find((candidate) => candidate.id === span.parentId);
    const parentArgs = parent?.attributes.arguments;
    if (typeof parentArgs === "string" && parentArgs.length > 0) {
      return formatJson(parentArgs);
    }
    return null;
  }

  const prompt = span.attributes.prompt;
  if (typeof prompt === "string" && prompt.length > 0) return prompt;

  return null;
}

export function stepReturn(
  span: TraceSpan,
  options: StepDetailOptions = {},
): string | null {
  const spans = options.spans ?? [];

  if (span.name === "subagent.result") {
    const result = span.attributes.result;
    if (typeof result !== "string" || result.length === 0) return null;
    return formatJson(result);
  }

  if (span.kind === "tool_call") {
    const output = span.attributes.output;
    if (typeof output === "string" && output.length > 0) {
      return output;
    }
    return null;
  }

  if (span.kind === "model_call" && span.label.includes("reply")) {
    const stored = span.attributes.context;
    if (typeof stored === "string" && stored.length > 0) {
      return stored;
    }
    return null;
  }

  if (span.kind === "model_call") {
    return null;
  }

  const output = span.attributes.output;
  if (typeof output === "string" && output.length > 0) return output;

  const result = span.attributes.result;
  if (typeof result === "string" && result.length > 0) return formatJson(result);

  return null;
}

export function stepReturnNote(span: TraceSpan): string | null {
  if (span.name === "subagent.result" && span.attributes.synthesized === true) {
    return "Synthesized from exec_command output (not a native Codex subagent span).";
  }
  return null;
}
