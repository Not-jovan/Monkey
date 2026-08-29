# Glass Box: Trace, Audit & Observability Middleware

## Problem
You cannot improve the agent if you do not know what is wrong with it.

We propose a middleware that traces through agent runs

## Goal
To build a middleware layer that allows for tracing and auditting, based on implemented policies.

## Implementation Plan
Use opentelemetry to collate logs and traces. All these logs are tracked via opentelemetry. The logs will then be used to do auditting.

### Tracing
On the AgentService level, we want to capture
- User request (Send message). 
- Agent creation, deletion, and update

Spans are:
```
agent.run
  ├── codex.turn
  │    ├── codex.api_request
  │    ├── tool.call
  │    └── web.request
  └── user.intervention
```

Essentially, our end goal is like:
```
                 agent.run
──────────────────────────────────────────────────────>

 User        Turn 1               Turn 2
  ●──────────□─────────────────────□────────────────●
             │                      │
             ├── model             ├── model
             ├── tool              ├── tool
             └── web               └── web
```

On The Codex CLI, we want to capture using `codex exec jsonl`
- Span
- Input
- Request Message
- Context
- Tool Calls / Subagent calls (Including Web fetches)
- External Service Calls 
- User actions
- Token Used (Breakdown by Reasoning, Thinking, Caching)
- Errors
- Duration

Since we are interfacing with codex as our agent runner, rely on the codex schemas.
```typescript
import { z } from "zod";

export const CodexCommonAttributes = z.object({
  "event.name": z.string(),
  "event.timestamp": z.string().datetime().optional(),
  "conversation.id": z.string().optional(),
  "app.version": z.string().optional(),
  "auth_mode": z.string().optional(),
  "user.account_id": z.string().optional(),
  "user.email": z.string().optional(),
  "originator": z.string().optional(),
  "service.name": z.string().optional(),
  "terminal.type": z.string().optional(),
  "model": z.string().optional(),
  "slug": z.string().optional(),
  "service_tier": z.string().optional(),
  "model_reasoning_effort": z.string().optional(),
  "env": z.string().optional(),
});

export const CodexStartupPhase = z.object({
  "event.name": z.literal("codex.startup_phase"),
  "startup.phase": z.string(),
  "startup.status": z.string().nullable().optional(),
  "duration_ms": z.coerce.number(),
});

export const CodexConversationStarts = z.object({
  "event.name": z.literal("codex.conversation_starts"),
  provider_name: z.string(),
  reasoning_effort: z.string().optional(),
  reasoning_summary: z.string().optional(),
  context_window: z.coerce.number().optional(),
  auto_compact_token_limit: z.coerce.number().optional(),
  approval_policy: z.string().optional(),
  sandbox_policy: z.unknown().optional(),
  mcp_servers: z.array(z.string()).optional(),
  active_profile: z.string().optional(),
});

export const CodexApiRequest = z.object({
  "event.name": z.literal("codex.api_request"),
  attempt: z.coerce.number().optional(),
  duration_ms: z.coerce.number().optional(),
  "http.response.status_code":
    z.coerce.number().optional(),
  "error.message":
    z.string().optional(),
});

export const CodexSseEvent = z.object({
  "event.name": z.literal("codex.sse_event"),
  "event.kind": z.string(),
  duration_ms: z.coerce.number().optional(),
  "error.message":
    z.string().optional(),

  // Present on response.completed
  input_token_count:
    z.coerce.number().optional(),
  output_token_count:
    z.coerce.number().optional(),
  cached_token_count:
    z.coerce.number().optional(),
  cache_write_token_count:
    z.coerce.number().optional(),
  reasoning_token_count:
    z.coerce.number().optional(),
  tool_token_count:
    z.coerce.number().optional(),
  ttft_ms:
    z.coerce.number().optional(),
});

export const CodexUserPrompt = z.object({
  "event.name": z.literal("codex.user_prompt"),
  prompt_length:
    z.coerce.number(),
  /**
   * "[REDACTED]" unless log_user_prompt = true. Please enable this.
   */
  prompt:
    z.string().optional(),
  // These are particularly useful on trace events.
  text_input_count:
    z.coerce.number().optional(),
  image_input_count:
    z.coerce.number().optional(),
  local_image_input_count:
    z.coerce.number().optional(),
});

export const CodexToolDecision = z.object({
  "event.name": z.literal("codex.tool_decision"),
  tool_name: z.string(),
  call_id: z.string(),
  decision: z.enum([
    "approved",
    "approved_for_session",
    "denied",
    "abort",
    // Some newer/variant Codex builds have exposed this.
    "approved_execpolicy_amendment",
  ]),

  source: z.enum([
    "config",
    "user",
  ]),
});

export const CodexToolResult = z.object({
  "event.name": z.literal("codex.tool_result"),
  tool_name: z.string(),
  call_id:
    z.string().optional(),
  arguments:
    z.unknown().optional(),
  duration_ms:
    z.coerce.number(),
  /**
   * Codex currently emits these as strings:
   * "true" / "false"
   */
  success:
    z.enum(["true", "false"]),
  output:
    z.string().optional(),
});

export const CodexWebsocketConnect = z.object({
  "event.name": z.literal("codex.websocket_connect"),
  duration_ms:
    z.coerce.number().optional(),
  success:
    z.string().optional(),
  "error.message":
    z.string().optional(),
  connection_reused:
    z.string().optional(),
});

export const CodexWebsocketRequest = z.object({
  "event.name": z.literal("codex.websocket_request"),
  duration_ms:
    z.coerce.number().optional(),
  success:
    z.string().optional(),
  "error.message":
    z.string().optional(),
  connection_reused:
    z.string().optional(),
});

export const CodexWebsocketEvent = z.object({
  "event.name": z.literal("codex.websocket_event"),
  "event.kind":
    z.string().optional(),
  duration_ms:
    z.coerce.number().optional(),
  success:
    z.string().optional(),
  "error.message":
    z.string().optional(),
});

export const CodexTurnTTFT = z.object({
  "event.name": z.literal("codex.turn_ttft"),
  duration_ms:
    z.coerce.number(),
});

export const CodexPluginInstallElicitationSent = z.object({
  "event.name":
    z.literal("codex.plugin_install_elicitation_sent"),
  tool_type:
    z.string(),
  tool_id:
    z.string(),
  tool_name:
    z.string(),
});

export const CodexEvent = z.discriminatedUnion("event.name", [
  CodexStartupPhase,
  CodexConversationStarts,
  CodexApiRequest,
  CodexSseEvent,
  CodexUserPrompt,
  CodexToolDecision,
  CodexToolResult,
  CodexWebsocketConnect,
  CodexWebsocketRequest,
  CodexWebsocketEvent,
  CodexTurnTTFT,
  CodexPluginInstallElicitationSent,
]);

export type CodexEvent = z.infer<typeof CodexEvent>;
```

If it makes sense to, consider making the Codex JSONL integration as an adapter, but if you realise it is a lot of redundant info, OR it does not make any meaningful difference, keep it as is.

For the sake of simplicity, reuse the server to implement the OTel collector.

In addition to that, add user specific traces for the same agent trace. For instance when the user:
- Initiates the agent
- Terminates the agent

Additionally, the system may provide additional traces like API, and server errors. This must be part of the end to end flow but will only be used for tracing, not for auditting.

This information will be used for audit automation which acts as a separate process.

### Auditting
Auditting is a separate step. It should ONLY READ written traces. 

It should be done in 2 phases,
1. As the trace runs, for step level auditting.
2. When the trace span completes, for end to end request auditting.

Note that audits are to be stored separately from traces, but they should be co-related.

2 audits, security and intent driven steps.
#### Security
- Use `gpt-oss-120b` to validate each trace step.
- Audit the intent of the message, identify prompt injection, refusal suppression, indirect prompt injection attempts. If yes, warn

Essentially, ask:
- Is this action dangerous?
- Is this prompt attempting injection?
- Is this tool being misused?
- Is the agent attempting to bypass restrictions?

#### Intent Driven Agent Steps
- Use `deepseek v4 flash` to validate the overarching trace.
- Intent Driven audit, based on the provided primary goal of the agent, identify deviations with the intent. Walk through the agent trace, compress the previous context while preserving the original goal. Understand whether the current action aligns with the intent of the primary goal. If not, warn.

Essentially, ask:
- Did the agent's actual sequence of actions contribute toward the user's intended objective?

## UI
The starter kit provides:
| Area | Provided by the Starter Kit | Your responsibility |
| --- | --- | --- |
| **Product experience** | React UI, Agent list, Create/Edit forms, lifecycle controls, Playground, Run status. | Keep the baseline working; add only the UI needed to expose your middleware. |
| **Control plane** | Fastify API, validation, asynchronous Runs, AgentService, JSON persistence. | Integrate real middleware behavior into the backend path. |
| **Agent Runtime** | Codex CLI, persistent sessions, per-Agent workspaces, disposable local containers. | Integrate team-designed middleware at the most appropriate execution boundary. |
| **Infrastructure** | Docker, Colima, Podman, Docker Compose, ECS scripts, and Terraform. | Use the smallest runtime path that proves your design. Cloud deployment is optional. |
| **Middleware** | Intentionally absent: no user identity, trace timeline, audit model, or hardened sandbox policy. | Select, adapt, combine, or invent a coherent set of middleware capabilities and demonstrate why they improve the platform. |

### Traces Page
Add a new page for traces. 
- The user can select which agent (Based on agent id) they want to view
- Once an agent is selected, show a table of agent runs. Use tanstack table. Users can select a row to view the run. Go to `/traces/:traceId`

### Specific Trace Page
- Show the Date and Time of the run at the top left AND an export trace button on the top right.
- If there are trace level of warnings, show them on the top left side of the top bar too, right besdie the Date and time of the run.
- Use React Konva to create a canvas component which shows the trace steps. Represent the following:
  - Circle representing user
  - Squircle representing trace step / action. Show the tool call / first few words of prompt / web call as the wrapping label (e.g. Prompt "What is life?", "Called XYZ tool", "Received XYZ")
  - Arrow edge pointing step with the label being the duration if its between steps OR user action labels (e.g. User "Prompt", User "Terminated")
  - Use left to right to indicate passing of time.
  - Use each new row to show subagent call OR user intervention. Basically, aside from when the user starts prompting, treat each new actor (Subagent OR user) on a new row with pointed arrows to the target actor's action.
- Make it pannable with a mouse.
- When a user clicks on a trace step, open a bottom panel which shows all the relevant details AND warnings associated with the step. 

## Misc Requirements
- Use a simple file storage for the OTel collector.
```
    traces/
        <trace-id>.json
    audits/
        <audit-id>.json
```
- Do not use type any, and unknown. Prefer type inference, not explicitly declared types. (e.g. No explicit return types from functions. Use zod/trpc type inference if available)
- Prefer typesafe envs (e.g. Check for t3env use, and cloudflare env bindings)
- In React, do not use `useEffect` to do state synchronization or asynchronous data fetching. Consider react query / trpc / server components / server actions / zustand before considering `useEffect`
- Do not type wrap variables that are already known to be number (with Number), and boolean (Boolean). Only consider if it is totally necessary.
- Do not abuse ternaries, prefer if blocks
- Do not overabstract, only abstract out functionalities when it is used more than once
- Do not create functions with the sole purpose to wrap functions or objects
- Do not typecast raw JSON blobs without validation, unless it is expected of an SDK. Use zod in TypeScript, and Pydantic in Python
- Do not invent types unless it is totally necessary, always check for existing types from libraries
- Only use comments as a way to give context to why the code is there (e.g. Limitations, Reasoning). Do not use it as a way to describe the code.
- Group common files by business domain unless otherwise specified
- When generating LLM prompts in code, keep it direct.
- The goal is to optimise for the project evaluaiton criteria. In particular
**End-to-end middleware behavior**, A real frontend-to-backend, Runtime, data, or infrastructure path with convincing functional evidence.
**Technical design and integration**, A clear rationale, coherent architecture, appropriate boundary, focused changes, and extensible contracts.
**Verification and robustness**, Automated tests, error handling, cleanup or recovery, redaction, and protection against obvious bypasses.

## Verification

- `npm run check` (typecheck + all vitest suites + build) is the single gate; run after each phase.
- Manual E2E per phase: `npm run poc` (or `npm run dev` + local-process runner for fast iteration), run the four demo scenarios above, confirm Playground still chats normally.
- Secret check before demo: grep APP_DATA_DIR/traces/ and the browser Network tab for the real ARK key — must be absent (acceptance checklist final item).
