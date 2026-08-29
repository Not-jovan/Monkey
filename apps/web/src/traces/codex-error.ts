// Codex reports a failed tool call as a Rust Debug-formatted struct:
//
//   exec_command failed: SandboxDenied { message: "...", output:
//     ExecToolCallOutput { exit_code: 1, stdout: StreamOutput { text: "" },
//       stderr: StreamOutput { text: "..." },
//       aggregated_output: StreamOutput { text: "..." } } }
//
// Three problems for anyone trying to diagnose a run. The newlines are escaped,
// so a stack trace arrives as one 4,000-character line. The same payload is
// repeated across message/stderr/aggregated_output — measured at 31% of the
// text on a real failure. And the part that says what actually went wrong sits
// in the middle of it.

export interface CodexFailure {
  tool: string | null;
  kind: string | null;
  exitCode: number | null;
  // Short, quotable lines: the thrown error and anything that was missing.
  problems: string[];
  // errno/syscall/address/port style facts, when the runtime supplied them.
  facts: { label: string; value: string }[];
  stack: string[];
  // Everything that was neither a problem line nor a stack frame.
  rest: string;
}

const HEADER = /^(\w+) failed:\s*(\w+)\s*\{/;

const FACT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "code", pattern: /\bcode:\s*'([^']+)'/ },
  { label: "errno", pattern: /\berrno:\s*(-?\d+)/ },
  { label: "syscall", pattern: /\bsyscall:\s*'([^']+)'/ },
  { label: "address", pattern: /\baddress:\s*'([^']*)'/ },
  { label: "port", pattern: /\bport:\s*(\d+)/ },
  { label: "signal", pattern: /\bsignal:\s*'([^']+)'/ },
];

// Turns one level of Rust's escaping back into real text.
//
// Single pass, because a chain of .replace() calls gets the nesting wrong: on
// `\\n` the old chain matched the trailing `\n` first and left a stray
// backslash before every newline, which then broke both de-duplication and the
// end-anchored problem patterns below.
function unescape(text: string) {
  return text.replace(/\\(.)/g, (_match, char: string) => {
    if (char === "n") return "\n";
    if (char === "r") return "\r";
    if (char === "t") return "\t";
    // Covers \" \' \\ and anything else Rust escaped verbatim.
    return char;
  });
}

// Pulls every double-quoted body out of the struct.
function quotedBodies(text: string) {
  const bodies: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const body = match[1] ?? "";
    if (body.length > 0) bodies.push(body);
  }
  return bodies;
}

// A payload that is still a Debug struct with its own string fields, meaning
// there is another level of escaping under it.
const STILL_NESTED = /\w+:\s*"|StreamOutput|ExecToolCallOutput/;
const MAX_NESTING = 4;

// Codex nests Debug-formatted structs inside each other's string fields, and
// the depth is not fixed: this run reported
// `CreateProcess { message: "Codex(Sandbox(Denied { ... }))" }`, one level
// deeper than the same failure used to arrive, so every payload was escaped
// twice. Unescaping a fixed number of times is therefore wrong in both
// directions — descend until the text stops looking like a struct.
function extractPayloads(text: string, depth = 0): string[] {
  const bodies = quotedBodies(text);
  if (bodies.length === 0 || depth >= MAX_NESTING) return [text];

  const payloads: string[] = [];
  for (const body of bodies) {
    const unescaped = unescape(body);
    if (STILL_NESTED.test(unescaped)) {
      payloads.push(...extractPayloads(unescaped, depth + 1));
    } else {
      payloads.push(unescaped);
    }
  }
  return payloads;
}

const STACK_FRAME = /^\s+at\s/;
const PROBLEM = [
  /^[A-Za-z]*Error: .+/,
  /^.+: command not found$/,
  /^.+: No such file or directory$/,
  /^.+: [Pp]ermission denied$/,
];

function isProblem(line: string) {
  return PROBLEM.some((pattern) => pattern.test(line.trim()));
}

// The outer struct name is the mechanism Codex used, not the reason it failed:
// this run's denial arrived as `CreateProcess`, with `Codex(Sandbox(Denied` —
// the part a reader actually needs — nested inside it. Prefer the inner cause
// when one is recognisable.
const INNER_CAUSES: { pattern: RegExp; label: string }[] = [
  { pattern: /Sandbox\(Denied/, label: "SandboxDenied" },
  { pattern: /\bSandboxDenied\b/, label: "SandboxDenied" },
  { pattern: /\bTimedOut\b|timed_out:\s*true/, label: "TimedOut" },
  { pattern: /Signal\(/, label: "Signal" },
];

function innerCause(text: string): string | null {
  for (const { pattern, label } of INNER_CAUSES) {
    if (pattern.test(text)) return label;
  }
  return null;
}

export function parseCodexFailure(text: string): CodexFailure | null {
  const header = HEADER.exec(text.trim());
  if (!header) return null;

  const exitMatch = /\bexit_code:\s*(-?\d+)/.exec(text);
  const facts: { label: string; value: string }[] = [];
  for (const { label, pattern } of FACT_PATTERNS) {
    const found = pattern.exec(text);
    if (found?.[1]) facts.push({ label, value: found[1] });
  }

  // message, stderr and aggregated_output normally carry the same text; keep
  // one copy of each distinct body rather than printing it three times.
  const bodies = extractPayloads(text);
  const distinct: string[] = [];
  for (const body of bodies) {
    if (body.trim().length === 0) continue;
    if (distinct.some((kept) => kept.includes(body) || body.includes(kept))) {
      // Keep whichever version is longer.
      const index = distinct.findIndex(
        (kept) => kept.includes(body) || body.includes(kept),
      );
      if (body.length > (distinct[index] ?? "").length) distinct[index] = body;
      continue;
    }
    distinct.push(body);
  }

  const problems: string[] = [];
  const stack: string[] = [];
  const rest: string[] = [];
  for (const body of distinct) {
    for (const line of body.split("\n")) {
      if (STACK_FRAME.test(line)) {
        const trimmed = line.trim();
        // The same frame arrives once per copy of the payload. Reporting "24
        // frames" for a 12-frame trace is worse than not counting at all.
        if (!stack.includes(trimmed)) stack.push(trimmed);
      } else if (isProblem(line)) {
        const trimmed = line.trim();
        if (!problems.includes(trimmed)) problems.push(trimmed);
      } else if (line.trim().length > 0) {
        rest.push(line);
      }
    }
  }

  return {
    tool: header[1] ?? null,
    kind: innerCause(text) ?? header[2] ?? null,
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    problems,
    facts,
    stack,
    rest: rest.join("\n"),
  };
}

// A tool's arguments arrive as JSON, and a shell script inside them keeps its
// escaped newlines — so a multi-line command renders as one unreadable line.
// Returns the command as real text when the arguments carry one.
export function readCommand(argumentsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const candidate = record.cmd ?? record.command ?? record.script;
  if (typeof candidate === "string") return candidate;
  if (Array.isArray(candidate)) return candidate.join(" ");
  return null;
}
