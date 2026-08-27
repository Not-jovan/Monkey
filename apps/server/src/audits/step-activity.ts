import type { TraceSpan } from "../traces/trace-model.js";

export type NetworkCall = {
  url: string;
  method?: string;
  request?: string;
  response?: string;
};

export type StepFile = {
  path: string;
  content: string[];
};

export type StepActivity = {
  networkCalls: NetworkCall[];
  files: StepFile[];
  commands: string[];
  input: string;
  output: string;
  servicesInteracted: string[];
};

function asString(value: string | number | boolean | undefined) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function parseObject(raw: string) {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

const URL_PATTERN = /https?:\/\/[^\s"'\\]+/gi;

export function extractUrls(text: string) {
  return [...text.matchAll(URL_PATTERN)].map((match) =>
    match[0].replace(/[),.;]+$/, ""),
  );
}

function commandFromArguments(raw: string) {
  const parsed = parseObject(raw);
  if (parsed) {
    return readString(parsed, ["cmd", "command", "command_line", "script"]);
  }
  return raw.trim();
}

function filesFromSpan(toolName: string, args: string, output: string) {
  const files: StepFile[] = [];
  const parsed = parseObject(args);
  const path = parsed
    ? readString(parsed, ["path", "file_path", "filePath", "filename"])
    : "";
  if (path) {
    const content = parsed ? readString(parsed, ["content", "contents", "patch"]) : "";
    files.push({
      path,
      content: (content || output).split("\n"),
    });
    return files;
  }
  if (
    /\.env$|\/\.env|README|auth\.json|\.ts$|\.tsx$|\.js$/.test(args) ||
    /read_file|write_file|apply_patch/.test(toolName)
  ) {
    const inferred = args.split(/\s+/).find((part) => part.includes("/") || part.startsWith("."));
    if (inferred) {
      files.push({ path: inferred, content: output.split("\n") });
    }
  }
  return files;
}

function networkFromText(text: string, method?: string) {
  const calls: NetworkCall[] = [];
  for (const url of extractUrls(text)) {
    const call: NetworkCall = { url };
    if (method) call.method = method;
    calls.push(call);
  }
  return calls;
}

export function collateSpanActivity(span: TraceSpan): StepActivity {
  const toolName = asString(span.attributes.toolName) || span.name.replace(/^tool\./, "");
  const args = asString(span.attributes.arguments);
  const output =
    asString(span.attributes.output) || asString(span.attributes.result);
  const input =
    asString(span.attributes.prompt) ||
    asString(span.attributes.context) ||
    args;
  const commands: string[] = [];
  if (toolName.includes("exec") || span.name.includes("exec_command")) {
    const command = commandFromArguments(args);
    if (command) commands.push(command);
  }

  const files = filesFromSpan(toolName, args, output);
  const parsed = parseObject(args);
  const urlFromArgs = parsed ? readString(parsed, ["url", "uri", "href"]) : "";
  const networkCalls: NetworkCall[] = [];
  if (urlFromArgs) {
    const method = parsed
      ? readString(parsed, ["method", "httpMethod"]).toUpperCase()
      : "";
    const call: NetworkCall = { url: urlFromArgs };
    if (method) call.method = method;
    if (output) call.response = output;
    if (args) call.request = args;
    networkCalls.push(call);
  }
  networkCalls.push(
    ...networkFromText([args, output, ...commands].join("\n")),
  );

  const uniqueCalls: NetworkCall[] = [];
  const seen = new Set<string>();
  for (const call of networkCalls) {
    const key = (call.method ?? "") + " " + call.url;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCalls.push(call);
  }

  const services = new Set<string>();
  for (const call of uniqueCalls) {
    try {
      services.add(new URL(call.url).hostname);
    } catch {
      // Ignore unparseable URLs when listing services.
    }
  }
  const mcp = asString(span.attributes.mcpServer);
  if (mcp) services.add(mcp);
  const subagent = asString(span.attributes.subagentType);
  if (subagent) services.add(subagent);

  return {
    networkCalls: uniqueCalls,
    files,
    commands,
    input,
    output,
    servicesInteracted: [...services],
  };
}

export function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function networkViolations(
  calls: NetworkCall[],
  whitelist: string[] | null,
) {
  if (whitelist === null) return [];
  const allowed = new Set(whitelist.map((host) => host.toLowerCase()));
  const violations: string[] = [];
  for (const call of calls) {
    const host = hostnameOf(call.url);
    if (!host || !allowed.has(host)) {
      violations.push(call.url);
    }
  }
  return violations;
}
