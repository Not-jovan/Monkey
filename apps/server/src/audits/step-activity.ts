import { z } from "zod";
import type { TraceRecord, TraceSpan } from "../traces/trace-model.js";

// The shape every audit policy reads (AUDIT_PLAN step 3). Production traces
// and the fixture dataset both reduce to this, so a policy never knows which
// it is looking at.
export interface StepNetworkCall {
  url: string;
  method?: string | undefined;
  request?: string | undefined;
  response?: string | undefined;
}

export interface StepFile {
  path: string;
  content: string[];
}

export interface StepActivity {
  networkCalls: StepNetworkCall[];
  files: StepFile[];
  commands: string[];
  input: string;
  output: string;
  servicesInteracted: string[];
  // Credential names detected before redaction masked their values. Carried as
  // names only — the values are never persisted — so the audit still knows a
  // secret was present after masking has removed its shape.
  declaredSecrets: { location: "request" | "response"; secretType: string }[];
}

export const emptyActivity = (): StepActivity => ({
  networkCalls: [],
  files: [],
  commands: [],
  input: "",
  output: "",
  servicesInteracted: [],
  declaredSecrets: [],
});

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // Bare hosts and scheme-less URLs still need to be comparable.
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s:?#]+)/i.exec(url.trim());
    return match ? match[1]!.toLowerCase() : null;
  }
}

// --- Fixture adapter -------------------------------------------------------

const datasetActivity = z.object({
  networkCalls: z
    .array(
      z.object({
        url: z.string(),
        method: z.string().optional(),
        request: z.string().optional(),
        response: z.string().optional(),
      }),
    )
    .default([]),
  files: z
    .array(z.object({ path: z.string(), content: z.array(z.string()).default([]) }))
    .default([]),
  commands: z.array(z.string()).default([]),
  input: z.string().default(""),
  output: z.string().default(""),
  servicesInteracted: z.array(z.string()).default([]),
  declaredSecrets: z
    .array(
      z.object({
        location: z.enum(["request", "response"]),
        secretType: z.string(),
      }),
    )
    .default([]),
});

export function activityFromDatasetCase(value: unknown): StepActivity {
  return datasetActivity.parse(value);
}

// --- Trace adapter ---------------------------------------------------------

// Codex reports shell invocations as a JSON argument blob; the command itself
// is the only part the audit policies care about.
const shellArguments = z.object({
  command: z.union([z.string(), z.array(z.string())]).optional(),
  cmd: z.union([z.string(), z.array(z.string())]).optional(),
  path: z.string().optional(),
  file_path: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
  method: z.string().optional(),
});

const urlPattern = /\bhttps?:\/\/[^\s"'`\<>)]+/gi;

function readString(attribute: unknown): string {
  return typeof attribute === "string" ? attribute : "";
}

function flattenCommand(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return value.join(" ");
  return null;
}

// Turns one persisted span into the activity view. Network calls seen in a
// shell command are recorded with the surrounding command as the request body
// so egress checks still see what was sent.
export function activityFromSpan(
  span: TraceSpan,
  trace: TraceRecord,
): StepActivity {
  const activity = emptyActivity();
  activity.input =
    readString(span.attributes.prompt) ||
    readString(span.attributes.arguments) ||
    readString(span.attributes.context) ||
    trace.prompt;
  activity.output =
    readString(span.attributes.output) || readString(span.attributes.result);

  const rawArguments = readString(span.attributes.arguments);
  if (rawArguments) {
    let parsedArguments: z.infer<typeof shellArguments> | null = null;
    try {
      const parsed = shellArguments.safeParse(JSON.parse(rawArguments));
      if (parsed.success) parsedArguments = parsed.data;
    } catch {
      // Non-JSON arguments are still scanned as raw text below.
    }
    const command =
      flattenCommand(parsedArguments?.command) ??
      flattenCommand(parsedArguments?.cmd);
    if (command) activity.commands.push(command);
    const filePath = parsedArguments?.path ?? parsedArguments?.file_path;
    if (filePath) {
      activity.files.push({
        path: filePath,
        content: (parsedArguments?.content ?? activity.output).split(/\r?\n/),
      });
    }
    if (parsedArguments?.url) {
      activity.networkCalls.push({
        url: parsedArguments.url,
        ...(parsedArguments.method ? { method: parsedArguments.method } : {}),
        request: rawArguments,
        response: activity.output,
      });
    }
  }

  const searchable = [rawArguments, activity.commands.join("\n")]
    .filter((part) => part.length > 0)
    .join("\n");
  const seen = new Set(activity.networkCalls.map((call) => call.url));
  for (const match of searchable.matchAll(urlPattern)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    activity.networkCalls.push({
      url,
      request: searchable,
      response: activity.output,
    });
  }

  for (const [attribute, location] of [
    ["secretsInRequest", "request"],
    ["secretsInResponse", "response"],
  ] as const) {
    for (const secretType of readString(span.attributes[attribute])
      .split(",")
      .filter((entry) => entry.length > 0)) {
      activity.declaredSecrets.push({ location, secretType });
    }
  }

  activity.servicesInteracted = [
    ...new Set(
      activity.networkCalls
        .map((call) => hostOf(call.url))
        .filter((host): host is string => host !== null),
    ),
  ];
  return activity;
}
