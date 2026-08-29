import type { IntentVersionEntry } from "../types";

// Turns the append-only version list into what actually changed at each step.
//
// The data for this was always being written — the triggering message, the
// classifier's reason, each added constraint — and then never shown anywhere,
// so a user had no way to tell that their message had moved the specification
// the agent is judged against. Silently changing the rules and not saying so is
// the part of the loop that was missing.

export interface IntentChange {
  id: string;
  // 1-based, and the number a reader sees. Position in the list is the version.
  version: number;
  createdAt: string | null;
  kind: "seed" | "classified" | "revert";
  // The message that caused the change, when one did.
  trigger: string | null;
  reason: string | null;
  addedConstraints: string[];
  removedConstraints: string[];
  objectiveBefore: string | null;
  objectiveAfter: string;
  // Which run the triggering message belonged to.
  traceId: string | null;
  // The version this one restores, for a revert.
  revertedFrom: string | null;
  revertedFromVersion: number | null;
  isCurrent: boolean;
}

function difference(left: string[], right: string[]) {
  const other = new Set(right);
  return left.filter((entry) => !other.has(entry));
}

export function intentChanges(
  versions: IntentVersionEntry[],
): IntentChange[] {
  const positionById = new Map(
    versions.map((entry, index) => [entry.id, index + 1]),
  );

  return versions.map((entry, index) => {
    const previous = index > 0 ? versions[index - 1] : undefined;
    const update = entry.update;
    const kind = update?.kind ?? (index === 0 ? "seed" : "classified");
    // Computed from the versions themselves rather than trusted from the
    // update record, so a revert reports what it actually dropped.
    const added = difference(entry.extended, previous?.extended ?? []);
    const removed = difference(previous?.extended ?? [], entry.extended);
    const revertedFrom = update?.revertedFrom ?? null;

    return {
      id: entry.id,
      version: index + 1,
      createdAt: entry.createdAt ?? null,
      kind,
      trigger: update?.message ?? null,
      reason: update?.reason ?? null,
      addedConstraints: added,
      removedConstraints: removed,
      objectiveBefore:
        previous && previous.objective !== entry.objective
          ? previous.objective
          : null,
      objectiveAfter: entry.objective,
      traceId: update?.traceId ?? null,
      revertedFrom,
      revertedFromVersion: revertedFrom
        ? (positionById.get(revertedFrom) ?? null)
        : null,
      isCurrent: index === versions.length - 1,
    };
  });
}

// Did this version actually alter the specification?
export function hasVisibleChange(change: IntentChange): boolean {
  return (
    change.addedConstraints.length > 0 ||
    change.removedConstraints.length > 0 ||
    change.objectiveBefore !== null
  );
}

// Which versions earn a timeline row. The seed is always kept — "where the spec
// started" is a real answer — and so is the version in force, even when it
// changed nothing: dropping it would leave the timeline with no "in force" row
// and make the version count disagree with the version numbers on the rows.
export function isMeaningful(change: IntentChange): boolean {
  return change.version === 1 || change.isCurrent || hasVisibleChange(change);
}

export function describeChange(change: IntentChange): string {
  if (change.kind === "revert") {
    return change.revertedFromVersion !== null
      ? "Restored version " + change.revertedFromVersion
      : "Restored an earlier version";
  }
  if (change.version === 1) return "Spec set from the agent's instructions";
  const parts: string[] = [];
  if (change.objectiveBefore !== null) parts.push("objective replaced");
  if (change.addedConstraints.length > 0) {
    parts.push(
      change.addedConstraints.length +
        " constraint" +
        (change.addedConstraints.length === 1 ? "" : "s") +
        " added",
    );
  }
  if (change.removedConstraints.length > 0) {
    parts.push(
      change.removedConstraints.length +
        " constraint" +
        (change.removedConstraints.length === 1 ? "" : "s") +
        " dropped",
    );
  }
  if (parts.length === 0) return "No visible change";
  return parts.join(", ").replace(/^./, (first) => first.toUpperCase());
}

// Which runs changed the spec, so a message in the Playground can say so.
// Uses the strict test rather than isMeaningful: telling someone their message
// changed the rules when it changed nothing would be worse than saying nothing.
export function versionByTrace(
  changes: IntentChange[],
): Map<string, IntentChange> {
  const byTrace = new Map<string, IntentChange>();
  for (const change of changes) {
    if (change.traceId && hasVisibleChange(change)) {
      byTrace.set(change.traceId, change);
    }
  }
  return byTrace;
}
