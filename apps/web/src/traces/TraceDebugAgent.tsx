import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, type TraceDetail } from "../api";
import {
  DEBUG_AGENT_FIRST_MESSAGE,
  DEBUG_AGENT_NAME,
  debugPrompt,
} from "./debug-prompt";

export function TraceDebugAgent({ detail }: { detail: TraceDetail }) {
  const navigate = useNavigate();
  const { trace, auditTraceId } = detail;

  const start = useMutation({
    mutationFn: async () => {
      const { agent } = await api.createAgent({
        name: DEBUG_AGENT_NAME,
        description: "",
        instructions: debugPrompt({
          origin: window.location.origin,
          traceId: trace.id,
          agentId: trace.agentId,
          auditOf: trace.auditOf,
          auditTraceId,
        }),
      });
      await api.sendMessage(agent.id, DEBUG_AGENT_FIRST_MESSAGE);
      return agent.id;
    },
    onSuccess: (agentId) => {
      void navigate("/?agent=" + agentId);
    },
  });

  return (
    <section className="trace-debug-agent" aria-labelledby="trace-debug-agent-heading">
      <h2 className="eyebrow" id="trace-debug-agent-heading">
        Debug Agent
      </h2>
      <p className="debug-agent-intro">
        Spawns an agent named Debug with this run's API index as its
        instructions, then asks it for a constraint set that would limit the
        same issues.
      </p>
      <button
        type="button"
        className="button button-primary"
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        {start.isPending ? "Starting…" : "Start Debug Agent"}
      </button>
      {start.error && (
        <p className="intent-change-error" role="alert">
          {start.error instanceof Error
            ? start.error.message
            : "Could not start the Debug Agent."}
        </p>
      )}
    </section>
  );
}
