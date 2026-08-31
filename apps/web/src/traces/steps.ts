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

const CACHED_PREFIX = "[CACHED] ";

export function withCachedPrefix(span: TraceSpan, label: string) {
  if (span.attributes.cached !== true) return label;
  if (label.startsWith(CACHED_PREFIX)) return label;
  return CACHED_PREFIX + label;
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
    return withCachedPrefix(
      span,
      subagentCallLabel(span) ?? span.label.replace(/^Subagent · /, ""),
    );
  }
  if (span.kind === "tool_call") {
    const toolName =
      typeof span.attributes.toolName === "string"
        ? span.attributes.toolName
        : span.name.replace(/^tool\./, "");
    return withCachedPrefix(span, "Tool · " + toolName);
  }
  return withCachedPrefix(span, span.label);
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

export function parseSubagentIndex(span: TraceSpan) {
  const raw = span.attributes.subagentIndex;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function nearestBoundary(
  startId: string | null,
  spanById: Map<string, TraceSpan>,
) {
  let current = spanById.get(startId ?? "");
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (isSubagentBoundary(current)) return current;
    current = spanById.get(current.parentId ?? "");
  }
  return null;
}

function callerLaneId(span: TraceSpan, spanById: Map<string, TraceSpan>) {
  const owner = nearestBoundary(span.parentId, spanById);
  if (owner) return owner.id;
  return "root";
}

// Which subagent a step belongs to. The server stamps this for anything it
// traced itself; the parent chain is the fallback for older spans.
export function laneIdForSpan(
  span: TraceSpan,
  spanById: Map<string, TraceSpan>,
) {
  if (span.actor === "user") return "user";

  const stamped = span.attributes.laneId;
  if (typeof stamped === "string" && stamped.length > 0) {
    if (isAuditorStepCheck(span)) {
      const parent = spanById.get(span.parentId ?? "");
      if (parent && isSubagentTask(parent) && siblingCheckCount(parent, spanById) > 1) {
        return auditorCheckLaneId(span, parent);
      }
    }
    return stamped;
  }

  if (span.name === "subagent.result") {
    const index = parseSubagentIndex(span);
    return "result:" + (span.parentId ?? span.id) + ":" + (index ?? span.id);
  }

  if (isSubagentTask(span)) {
    return callerLaneId(span, spanById);
  }

  const owner = nearestBoundary(span.parentId, spanById);
  if (owner) return owner.id;
  return "root";
}

function siblingCheckCount(
  spawn: TraceSpan,
  spanById: Map<string, TraceSpan>,
) {
  let count = 0;
  for (const other of spanById.values()) {
    if (other.parentId === spawn.id && isAuditorStepCheck(other)) count += 1;
  }
  return count;
}

function auditorCheckLaneId(span: TraceSpan, spawn: TraceSpan) {
  const target = span.attributes.targetSpanId;
  const type = spawn.attributes.subagentType;
  if (
    typeof target === "string" &&
    target.length > 0 &&
    typeof type === "string" &&
    type.length > 0
  ) {
    return "audit:" + target + ":" + type;
  }
  return span.id;
}

// The spawn a lane hangs off, or null when the lane is a caller's own — "user",
// "root", "auditor", or a lane whose spawn is not in this list.
function laneOwnerId(
  laneId: string,
  laneSteps: TraceSpan[],
  spanById: Map<string, TraceSpan>,
) {
  const named = spanById.get(laneId);
  if (named && isSubagentTask(named)) return named.id;
  if (laneId.startsWith("result:")) {
    const owner = spanById.get(laneId.split(":")[1] ?? "");
    if (owner && isSubagentTask(owner)) return owner.id;
  }
  if (laneId.startsWith("audit:")) {
    const spawn = spanById.get(laneSteps[0]?.parentId ?? "");
    if (spawn && isSubagentTask(spawn)) return spawn.id;
  }
  return null;
}

export interface OrderedStep {
  span: TraceSpan;
  depth: number;
}

// Steps as a tree, not a time-sorted line. Checks that run concurrently start
// in the same millisecond, so ordering the whole run by time let one subagent's
// work land under another subagent's row. A spawn is followed by the lanes it
// opened, however the clock fell.
export function orderedSteps(spans: TraceSpan[]): OrderedStep[] {
  const spanById = new Map(spans.map((span) => [span.id, span]));
  const ordered = spans.filter(isVisibleStep).sort((left, right) => {
    const byTime = stepSortTime(left, spanById).localeCompare(
      stepSortTime(right, spanById),
    );
    if (byTime !== 0) return byTime;
    if (left.id === right.parentId) return -1;
    if (right.id === left.parentId) return 1;
    if (left.kind === "tool_call" && right.kind !== "tool_call") return -1;
    if (right.kind === "tool_call" && left.kind !== "tool_call") return 1;
    return left.id.localeCompare(right.id);
  });

  const laneOf = new Map<string, string>();
  const byLane = new Map<string, TraceSpan[]>();
  for (const span of ordered) {
    const laneId = laneIdForSpan(span, spanById);
    laneOf.set(span.id, laneId);
    const list = byLane.get(laneId);
    if (list) {
      list.push(span);
      continue;
    }
    byLane.set(laneId, [span]);
  }

  const lanesBySpawn = new Map<string, string[]>();
  const rootLanes = new Set<string>();
  for (const [laneId, laneSteps] of byLane) {
    const owner = laneOwnerId(laneId, laneSteps, spanById);
    if (owner === null) {
      rootLanes.add(laneId);
      continue;
    }
    const lanes = lanesBySpawn.get(owner);
    if (lanes) {
      lanes.push(laneId);
      continue;
    }
    lanesBySpawn.set(owner, [laneId]);
  }

  const steps: OrderedStep[] = [];
  const emitted = new Set<string>();
  const emit = (span: TraceSpan, depth: number) => {
    if (emitted.has(span.id)) return;
    emitted.add(span.id);
    steps.push({ span, depth });
    if (!isSubagentTask(span)) return;
    for (const laneId of lanesBySpawn.get(span.id) ?? []) {
      for (const child of byLane.get(laneId) ?? []) emit(child, depth + 1);
    }
  };

  // The caller's own lanes stay one sequence: a second prompt must not jump
  // ahead of the work the first one caused.
  for (const span of ordered) {
    if (rootLanes.has(laneOf.get(span.id) ?? "")) emit(span, 0);
  }
  // A lane whose spawn never made the list would otherwise lose its steps.
  for (const span of ordered) emit(span, 0);
  return steps;
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
