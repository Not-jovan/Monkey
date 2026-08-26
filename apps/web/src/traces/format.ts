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
