export function formatDuration(ms: number | null) {
  if (ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1_000) return ms + " ms";
  if (ms < 60_000) return (ms / 1_000).toFixed(1) + " s";
  return Math.floor(ms / 60_000) + "m " + Math.round((ms % 60_000) / 1_000) + "s";
}

export function spanDuration(startedAt: string, endedAt: string | null) {
  if (!endedAt) return null;
  return new Date(endedAt).getTime() - new Date(startedAt).getTime();
}

// Spans closed without a measured duration were cut off (crash, restart).
// The trace's endedAt is then "when we noticed", not "when work stopped".
export function lastRecordedWorkEndedAt(
  spans: { endedAt: string | null; durationMs: number | null }[],
): string | null {
  let latest: string | null = null;
  for (const span of spans) {
    if (span.durationMs === null || !span.endedAt) continue;
    if (latest === null || span.endedAt > latest) latest = span.endedAt;
  }
  return latest;
}

export function displayTraceEndedAt(
  endedAt: string | null,
  spans: { endedAt: string | null; durationMs: number | null }[],
): string | null {
  const workEndedAt = lastRecordedWorkEndedAt(spans);
  const cutOff = spans.some(
    (span) => span.endedAt !== null && span.durationMs === null,
  );
  if (cutOff && workEndedAt) return workEndedAt;
  return endedAt;
}

export function displaySpanDurationMs(
  span: {
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    status: string;
  },
  spans: { endedAt: string | null; durationMs: number | null }[],
): number | null {
  if (span.status === "running") return null;
  if (span.durationMs !== null) return span.durationMs;
  return spanDuration(
    span.startedAt,
    displayTraceEndedAt(span.endedAt, spans),
  );
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatTokenCount(value: number) {
  return value.toLocaleString();
}
