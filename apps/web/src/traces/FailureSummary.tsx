import type { Diagnosis } from "./failure";
import { FailureBlock } from "./FailureBlock";

// The first thing read when something went wrong, ordered as a person asks the
// questions: whose fault, what broke, what to do, where to look.
//
// Attribution leads because it is the answer most easily got wrong. Before
// this, every failure rendered as one undifferentiated error string, so a
// sandbox denial and a broken command looked identical — and the natural
// response to both was to blame the agent.
//
// It renders for a recovered run too. A run that absorbed a denial and carried
// on looks completely clean otherwise, which makes it the easiest kind of
// problem to never notice.

export function FailureSummary({
  diagnosis,
  onSelect,
}: {
  diagnosis: Diagnosis;
  onSelect: (spanId: string) => void;
}) {
  const recovered = diagnosis.outcome === "recovered";
  return (
    <section
      className={
        "failure-summary failure-blame-" +
        diagnosis.blame +
        (recovered ? " failure-recovered" : "")
      }
      aria-labelledby="failure-summary-heading"
    >
      <div className="failure-summary-head">
        <span className="failure-layer">
          {diagnosis.layerLabel} · {diagnosis.kind}
        </span>
        <span className="failure-retry">{diagnosis.retryability}</span>
        {recovered && (
          <span className="failure-outcome">the agent worked around this</span>
        )}
      </div>

      <h2 id="failure-summary-heading">{diagnosis.headline}</h2>
      <p className="failure-attribution">{diagnosis.attribution}</p>
      {recovered && (
        <p className="failure-attribution">
          The run still completed, so nothing here was reported as a failure.
        </p>
      )}
      <p className="failure-remedy">{diagnosis.remedy}</p>

      {(diagnosis.where || diagnosis.causedBy) && (
        <div className="failure-jumps">
          {diagnosis.where && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => onSelect(diagnosis.where!.spanId)}
            >
              Failing step: {diagnosis.where.label}
            </button>
          )}
          {/* Separating a bad plan from a bad execution is the distinction that
              decides what you change — but the link itself is the model call
              that was in flight when this step was decided, which is an
              ordering inference over an async event stream, not a fact the
              runtime reported. Hedged in the label for that reason. */}
          {diagnosis.causedBy && (
            <button
              type="button"
              className="button button-ghost"
              title="The model call in flight when this step was decided. Inferred from ordering, not reported by the runtime."
              onClick={() => onSelect(diagnosis.causedBy!.spanId)}
            >
              Likely planned by: {diagnosis.causedBy.label}
            </button>
          )}
        </div>
      )}

      {diagnosis.envelope && diagnosis.raw && (
        <FailureBlock failure={diagnosis.envelope} raw={diagnosis.raw} />
      )}
      {!diagnosis.envelope && diagnosis.raw && (
        <pre className="failure-raw">{diagnosis.raw}</pre>
      )}
    </section>
  );
}
