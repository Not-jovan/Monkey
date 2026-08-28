import type { TraceSpan, TraceUsage } from "../types";

function numberAttr(span: TraceSpan, key: string) {
  const value = span.attributes[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function spanUsage(span: TraceSpan): TraceUsage | null {
  const recordedInput = numberAttr(span, "inputTokens");
  const cachedTokens = numberAttr(span, "cachedTokens");
  const outputTokens = numberAttr(span, "outputTokens");
  const reasoningTokens = numberAttr(span, "reasoningTokens");
  const toolTokens = numberAttr(span, "toolTokens");
  if (
    recordedInput === null &&
    cachedTokens === null &&
    outputTokens === null &&
    reasoningTokens === null &&
    toolTokens === null
  ) {
    return null;
  }
  const cached = cachedTokens ?? 0;
  let inputTokens = recordedInput ?? 0;
  // Cached tokens are a subset of input. Older spans recorded cache without
  // the matching input total, so treat cache as a floor rather than a bar
  // that sits on a zero-width track.
  if (inputTokens < cached) inputTokens = cached;
  return {
    inputTokens,
    cachedTokens: cached,
    outputTokens: outputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    toolTokens: toolTokens ?? 0,
  };
}

export function usageShare(part: number, total: number) {
  if (total <= 0) return 0;
  const share = part / total;
  if (share < 0) return 0;
  if (share > 1) return 1;
  return share;
}
