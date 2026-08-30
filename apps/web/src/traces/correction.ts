import type { IntentCorrection } from "../types";

// Findings covered by rules that are still in force. Undoing a correction
// deliberately opens its findings again.
export function correctedFindingIds(corrections: IntentCorrection[]) {
  const ids = new Set<string>();
  for (const correction of corrections) {
    if (correction.revertedAt !== null) continue;
    for (const findingId of correction.findingIds) ids.add(findingId);
  }
  return ids;
}

// A correction is enforced for the Agent, but its evidence and history belong
// to the run where the operator made it. Trace pages must not borrow another
// run's correction record merely because both runs share an Agent.
export function correctionsForTrace(
  corrections: IntentCorrection[],
  traceId: string,
) {
  return corrections.filter((correction) => correction.traceId === traceId);
}

export interface DisplayedConstraint {
  text: string;
  humanCorrection: boolean;
}

function normalized(value: string) {
  return value.trim().toLowerCase().replace(/[.\s]+$/, "");
}

// The auditor's derived constraints and the operator's active corrections are
// two records of the same current spec. Present both, without showing the same
// rule twice if a later audit has already derived the human-authored wording.
export function displayedConstraints(
  derived: string[],
  corrections: IntentCorrection[],
): DisplayedConstraint[] {
  const result = derived.map((text) => ({ text, humanCorrection: false }));
  const byText = new Map(result.map((entry, index) => [normalized(entry.text), index]));

  for (const correction of corrections) {
    if (correction.revertedAt !== null) continue;
    const text = correction.correction.trim();
    if (text.length === 0) continue;
    const key = normalized(text);
    const existing = byText.get(key);
    if (existing !== undefined) {
      result[existing] = { ...result[existing]!, humanCorrection: true };
      continue;
    }
    byText.set(key, result.length);
    result.push({ text, humanCorrection: true });
  }

  return result;
}
