import type { TraceUsage } from "../types";
import { formatTokenCount } from "./format";
import { usageShare } from "./usage";

export function UsageBars({
  model,
  usage,
}: {
  model: string | null;
  usage: TraceUsage;
}) {
  let modelName = "Model";
  if (model && model.length > 0) modelName = model;
  const title = modelName + " Usage";
  const cachedShare = usageShare(usage.cachedTokens, usage.inputTokens);
  const reasoningShare = usageShare(usage.reasoningTokens, usage.outputTokens);
  let uncachedShare = 0;
  let otherOutputShare = 0;
  if (usage.inputTokens > 0) uncachedShare = 1 - cachedShare;
  if (usage.outputTokens > 0) otherOutputShare = 1 - reasoningShare;

  let inputTrack = <span className="usage-seg usage-seg-empty" />;
  if (usage.inputTokens > 0) {
    inputTrack = (
      <>
        <span
          className="usage-seg usage-seg-cached"
          style={{ width: cachedShare * 100 + "%" }}
        />
        <span
          className="usage-seg usage-seg-input"
          style={{ width: uncachedShare * 100 + "%" }}
        />
      </>
    );
  }

  let outputTrack = <span className="usage-seg usage-seg-empty" />;
  if (usage.outputTokens > 0) {
    outputTrack = (
      <>
        <span
          className="usage-seg usage-seg-reasoning"
          style={{ width: reasoningShare * 100 + "%" }}
        />
        <span
          className="usage-seg usage-seg-output"
          style={{ width: otherOutputShare * 100 + "%" }}
        />
      </>
    );
  }

  return (
    <section className="usage-bars" aria-label={title}>
      <h2 className="eyebrow">{title}</h2>
      <div className="usage-bars-grid">
        <div>
          <div className="usage-track" aria-hidden="true">
            {inputTrack}
          </div>
          <p>
            {formatTokenCount(usage.cachedTokens)} Cached /{" "}
            {formatTokenCount(usage.inputTokens)} Total Input
          </p>
        </div>
        <div>
          <div className="usage-track" aria-hidden="true">
            {outputTrack}
          </div>
          <p>
            {formatTokenCount(usage.reasoningTokens)} Reasoning /{" "}
            {formatTokenCount(usage.outputTokens)} Total Output
          </p>
        </div>
      </div>
    </section>
  );
}
