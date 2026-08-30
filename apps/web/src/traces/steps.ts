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
  // Inferred "subagent" rows from exec_command are not a spawn. Hide them so
  // older traces do not grow extra lanes for a shell-out.
  if (span.name === "subagent.result" && span.attributes.synthesized === true) {
    return false;
  }
  if (span.attributes.layoutOnly === true) return false;
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

export function previewLabel(text: string, limit: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1) + "…";
}

// "Model · after update_plan" → "after update_plan". The kind is already on
// the step; the spawn only has room for which step it asked about.
export function shortStepSubject(subject: string) {
  const parts = subject.split(" · ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && (parts[0] === "Model" || parts[0] === "Tool")) {
    return previewLabel(parts.slice(1).join(" · "), 28);
  }
  return previewLabel(subject, 28);
}

function firstNonEmptyLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? ""
  );
}

export function subagentResultHeadline(span: TraceSpan) {
  const result = span.attributes.result;
  if (typeof result !== "string" || result.length === 0) return null;
  const line = firstNonEmptyLine(result);
  if (!line) return null;
  return previewLabel(line, 36);
}

export function isSubagentTask(span: TraceSpan) {
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

export function subagentCallLabel(span: TraceSpan) {
  const type = span.attributes.subagentType;
  if (typeof type !== "string" || type.length === 0) return null;
  const target = span.attributes.targetLabel;
  if (typeof target === "string" && target.length > 0) {
    return type + " · " + shortStepSubject(target);
  }
  return type;
}

export function isAuditorStepCheck(span: TraceSpan) {
  if (span.kind !== "model_call") return false;
  if (span.name === "audit.identify") return true;
  return span.name.startsWith("audit.step.");
}

export function stepHeadline(span: TraceSpan) {
  if (span.name === "subagent.result") {
    return subagentResultHeadline(span) ?? span.label;
  }
  if (isSubagentTask(span)) {
    // The list already chips this as Subagent. Repeating that here is what
    // made auditor rows read as "SubagentSubagent · injection".
    return subagentCallLabel(span) ?? span.label.replace(/^Subagent · /, "");
  }
  if (span.kind === "tool_call") {
    const toolName =
      typeof span.attributes.toolName === "string"
        ? span.attributes.toolName
        : span.name.replace(/^tool\./, "");
    return "Tool · " + toolName;
  }
  return span.label;
}

function stepSortTime(span: TraceSpan, spanById: Map<string, TraceSpan>) {
  if (span.name === "subagent.result" && span.parentId) {
    const parent = spanById.get(span.parentId);
    if (parent) return sortTime(parent);
  }
  return sortTime(span);
}

export function isSubagentBoundary(span: TraceSpan) {
  return isSubagentTask(span);
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
    .sort((left, right) => {
      const byTime = stepSortTime(left, spanById).localeCompare(
        stepSortTime(right, spanById),
      );
      if (byTime !== 0) return byTime;
      if (left.id === right.parentId) return -1;
      if (right.id === left.parentId) return 1;
      if (left.kind === "tool_call" && right.kind !== "tool_call") return -1;
      if (right.kind === "tool_call" && left.kind !== "tool_call") return 1;
      return left.id.localeCompare(right.id);
    })
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
