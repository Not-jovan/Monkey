import { createServer } from "node:http";

const arkPort = Number(process.env.E2E_ARK_PORT ?? 3211);

// One superset is accepted by every audit schema: Zod strips fields that a
// particular check does not use. Keeping the answers clean makes this fixture
// prove orchestration and persistence, while policy edge cases remain pinned
// by the deterministic server tests.
const verdict = {
  classification: "NO_CHANGE",
  reason: "Deterministic credential-free E2E verdict.",
  extendedIntent: [],
  removedIntent: [],
  objective: null,
  summary: "The agent created trace-check.md in its workspace.",
  notInAlignment: [],
  newObjectives: [],
  dangerous: false,
  promptInjection: [],
  actedOnExternalInstructions: [],
  restrictionBypass: false,
  secretRelevance: [],
  calls: [],
  misuse: false,
  flags: [],
  writes: [],
  carriedOut: [],
  unclear: [],
  resolved: [],
  unsupportedFindings: [],
  missedSignals: [],
};

const ark = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    // Parse the request so malformed client traffic cannot receive a false
    // positive fixture response.
    try {
      JSON.parse(body);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": "offline-e2e-ark",
    });
    response.end(
      JSON.stringify({
        id: "offline-e2e-completion",
        model: "offline-e2e-model",
        choices: [{ message: { content: JSON.stringify(verdict) } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
    );
  });
});

await new Promise((resolve, reject) => {
  ark.once("error", reject);
  ark.listen(arkPort, "127.0.0.1", resolve);
});

process.env.ARK_BASE_URL = `http://127.0.0.1:${arkPort}`;
process.env.ARK_API_KEY = "offline-e2e-secret-that-must-be-redacted";
process.env.ARK_MODEL = "offline-e2e-model";
process.env.AUDIT_SECURITY_MODEL = "offline-e2e-model";
process.env.AUDIT_INTENT_MODEL = "offline-e2e-model";
process.env.AUDIT_MODEL_STREAM = "false";
process.env.AUDIT_ENABLED = "true";
process.env.RUNTIME_PROVIDER = "local-process";
process.env.AGENT_RUNTIME = "codex";
process.env.NODE_ENV = "production";

process.once("exit", () => ark.close());

await import("../../../apps/server/dist/index.js");
