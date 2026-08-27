import type { SpanKind, TraceSpan } from "../types";

// Which spans count as a step, and how they nest. Shared so the step list and
// the flow canvas can never disagree about what a run contained.

const VISIBLE_KINDS = new Set<SpanKind>([
  "user_action",
  "tool_call",
  "model_call",
  "system",
]);

export function isErrorStep(span: TraceSpan) {
  return span.status === "error" || Boolean(span.error);
}

export function isVisibleStep(span: TraceSpan) {
  // An error is always worth showing, whatever kind produced it.
  if (isErrorStep(span)) return true;
  return VISIBLE_KINDS.has(span.kind);
}

export function sortTime(span: TraceSpan) {
  // Wrappers are placed by when they closed; everything else by when it began.
  if (span.kind === "turn" || span.kind === "run") {
    return span.endedAt ?? span.startedAt;
  }
  return span.startedAt;
}

export function isSubagentToolName(name: string) {
  const normalized = name.toLowerCase();
  if (normalized === "task") return true;
  if (normalized === "spawn_agent") return true;
  return normalized.endsWith("/spawn_agent");
}

export function isSubagentTask(span: TraceSpan) {
  if (span.attributes.subagent === true) return true;
  if (span.kind !== "tool_call") return false;
  const toolName = span.attributes.toolName;
  if (typeof toolName === "string" && isSubagentToolName(toolName)) {
    return true;
  }
  const normalizedName = span.name.toLowerCase();
  if (normalizedName === "tool.task") return true;
  if (normalizedName === "tool.spawn_agent") return true;
  return normalizedName.endsWith(".spawn_agent");
}

export function isSubagentBoundary(span: TraceSpan) {
  if (isSubagentTask(span)) return true;
  return span.attributes.spawnsSubagents === true;
}

// How deeply a step sits inside spawned subagents. Drives indentation in the
// list, so a subagent's work reads as belonging to the task that spawned it.
export function subagentDepth(
  span: TraceSpan,
  spanById: Map<string, TraceSpan>,
) {
  let depth = 0;
  let current = spanById.get(span.parentId ?? "");
  const seen = new Set<string>([span.id]);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isSubagentTask(current)) depth += 1;
    current = spanById.get(current.parentId ?? "");
  }
  return depth;
}

export interface OrderedStep {
  span: TraceSpan;
  depth: number;
}

export function orderedSteps(spans: TraceSpan[]): OrderedStep[] {
  const spanById = new Map(spans.map((span) => [span.id, span]));
  return spans
    .filter(isVisibleStep)
    .sort((left, right) => sortTime(left).localeCompare(sortTime(right)))
    .map((span) => ({ span, depth: subagentDepth(span, spanById) }));
}

// The actor behind a step, said plainly. Screen readers announce this, so it
// has to make sense read aloud rather than only as a coloured chip.
export function stepRole(span: TraceSpan): string {
  if (span.kind === "user_action") return "You";
  if (span.kind === "model_call") return "Model";
  if (span.kind === "tool_call") {
    return isSubagentTask(span) ? "Subagent" : "Tool";
  }
  return "System";
}

export function stepStatusText(span: TraceSpan): string {
  if (span.status === "error") return "failed";
  if (span.status === "running") return "running";
  return "ok";
}
