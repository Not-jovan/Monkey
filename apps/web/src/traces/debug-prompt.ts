// A pasteable index of the APIs that apply to this run, with the ids already
// filled in. Diagnosing agents should start at the `/ai` case file and only
// open the Glass Box dump when they need a span that file clipped.

export const DEBUG_AGENT_NAME = "Debug";

export const DEBUG_AGENT_FIRST_MESSAGE =
  "Deduce the issue and give me the constraint set to minimise these issues";

export function debugPrompt(input: {
  origin: string;
  traceId: string;
  agentId: string;
  auditOf: string | null;
  auditTraceId: string | null;
}): string {
  const origin = input.origin.replace(/\/$/, "");
  const lines = [
    "Use when debugging,",
    line(
      origin,
      "GET",
      "/api/traces/" + input.traceId + "/ai",
      "you need the compressed case file for this run (diagnosis, trajectory, findings). Start here",
    ),
    line(
      origin,
      "GET",
      "/api/traces/" + input.traceId,
      "the case file clipped a span and you need the full Glass Box dump",
    ),
    line(
      origin,
      "GET",
      "/api/traces/" + input.traceId + "/download",
      "exporting this run as a JSON file",
    ),
  ];

  if (input.auditOf === null) {
    lines.push(
      line(
        origin,
        "GET",
        "/api/runs/" + input.traceId,
        "you need run status, output, error, and attributed failure",
      ),
    );
  }

  lines.push(
    line(
      origin,
      "GET",
      "/api/audits/" + input.traceId,
      "you need what the auditor did while judging this run",
    ),
    line(
      origin,
      "GET",
      "/api/audits/" + input.traceId + "/archive",
      "downloading the auditor's memory zip for this run",
    ),
    line(
      origin,
      "POST",
      "/api/traces/" + input.traceId + "/audit",
      "you want to re-audit this run",
    ),
  );

  if (input.auditTraceId) {
    lines.push(
      line(
        origin,
        "GET",
        "/api/traces/" + input.auditTraceId + "/ai",
        "you need the auditor's own case file",
      ),
      line(
        origin,
        "GET",
        "/api/traces/" + input.auditTraceId,
        "you need the auditor's full Glass Box dump",
      ),
    );
  }

  lines.push(
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId,
      "you need this agent's name, instructions, and status",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/traces/ai",
      "listing this agent's runs as a triage index. Query blame=agent or status=failed",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/traces",
      "you need the UI-shaped list of this agent's runs",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/failures/ai",
      "grouping repeated failures for this agent",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/failures",
      "you need the UI-shaped grouped failures",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/runs",
      "listing this agent's run records (status, output, failure)",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/messages",
      "you need the conversation this run belongs to",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/intent",
      "you need the standing spec this run was judged against",
    ),
    line(
      origin,
      "GET",
      "/api/agents/" + input.agentId + "/corrections",
      "you need human corrections applied from this agent's runs",
    ),
  );

  return lines.join("\n");
}

function line(origin: string, method: string, path: string, when: string) {
  return "- " + method + " " + origin + path + " | Use when " + when;
}
