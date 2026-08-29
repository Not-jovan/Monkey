import { Link } from "react-router";
import type { ContextView, RunContext } from "../types";

// What the agent knew going in, and what it leaves behind.
//
// Both halves were already computed and persisted; neither was on any API
// response, so a reader had no way to tell whether a run was continuing earlier
// work or starting cold. Without that, a step that looks unmotivated in
// isolation reads as a defect when it is often the second half of something.

function Provenance({ source }: { source: RunContext["source"] }) {
  return (
    <span
      className={"context-source context-source-" + source}
      title={
        source === "model"
          ? "Compressed by the audit model"
          : "Derived from the trace itself, with no model involved"
      }
    >
      {source === "model" ? "model summary" : "derived"}
    </span>
  );
}

function Panel({
  title,
  context,
  empty,
}: {
  title: string;
  context: RunContext | null;
  empty: string;
}) {
  return (
    <div className="context-panel">
      <div className="context-panel-head">
        <h3 className="eyebrow">{title}</h3>
        {context && <Provenance source={context.source} />}
      </div>
      {context ? (
        <p className="context-summary">{context.summary}</p>
      ) : (
        <p className="muted-cell">{empty}</p>
      )}
    </div>
  );
}

export function TraceContext({ context }: { context: ContextView | null }) {
  if (!context || context.chainLength === 0) return null;

  return (
    <section className="trace-context" aria-labelledby="trace-context-heading">
      <div className="trace-context-head">
        <h2 className="eyebrow" id="trace-context-heading">
          Prior context
        </h2>
        <span className="muted-cell">
          Run {context.position} of {context.chainLength} on this session
        </span>
        <div className="context-links">
          {context.previousTraceId && (
            <Link
              className="button button-ghost"
              to={"/traces/" + context.previousTraceId}
            >
              ← Previous run
            </Link>
          )}
          {context.nextTraceId && (
            <Link
              className="button button-ghost"
              to={"/traces/" + context.nextTraceId}
            >
              Next run →
            </Link>
          )}
        </div>
      </div>
      <div className="context-panels">
        <Panel
          title="Carried in"
          context={context.carriedIn}
          empty="Nothing — this is the first run on this session."
        />
        <Panel
          title="Carried out"
          context={context.carriedOut}
          empty="Not recorded yet; it is written when the run ends."
        />
      </div>
    </section>
  );
}
