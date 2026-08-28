import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import {
  classifyRunFailure,
  noAgentMessageFailure,
  RunFailureError,
} from "./failures.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

// Codex reports its own failures on the event stream, and those are far more
// specific than stderr. Falls through to stderr, then to an explicit placeholder
// — the previous `errors.at(-1) ?? stderr.trim() ?? "No error detail"` could
// never reach its last arm, because .trim() returns "" rather than nullish, so
// an empty stderr produced a message that trailed off after the colon.
export function errorEvidence(errors: string[], stderr: string): string {
  const reported = errors.at(-1)?.trim();
  if (reported) return reported;
  const tail = stderr.trim();
  if (tail) return tail;
  return "The Runtime exited without reporting a reason.";
}

// What counts as Codex reporting a failure on its own event stream.
//
// Defined once and shared with the trace service. They previously disagreed —
// this side collected only `error`, the trace side also counted `turn.failed` —
// so the same run could report two different error counts, and the failure
// classifier could miss the one event that said what actually went wrong.
export function readStreamError(
  event: Record<string, unknown>,
): string | null {
  if (event.type === "error") {
    if (typeof event.message === "string" && event.message.length > 0) {
      return event.message;
    }
    if (typeof event.error === "string" && event.error.length > 0) {
      return event.error;
    }
    return "Codex reported an unknown error";
  }
  if (event.type === "turn.failed") {
    const detail = event.error;
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (detail !== null && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    return "The Codex turn failed";
  }
  return null;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onEvent?: (event: Record<string, unknown>) => void,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  onEvent?.(event);

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  const streamError = readStreamError(event);
  if (streamError !== null) {
    parsed.errors.push(streamError);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed, request.onEvent);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", (error: Error) =>
          reject(
            new RunFailureError(
              classifyRunFailure(error.message, { spawnFailed: true }),
            ),
          ),
        );
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed, request.onEvent);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new RunFailureError(
          classifyRunFailure("", {
            timedOut: true,
            timeoutMs: this.config.codexTimeoutMs,
            exitCode,
          }),
        );
      }
      if (active.outputExceeded) {
        throw new RunFailureError(
          classifyRunFailure("", {
            outputExceeded: true,
            maxOutputBytes: this.config.codexMaxOutputBytes,
            exitCode,
          }),
        );
      }
      if (exitCode !== 0) {
        throw new RunFailureError(
          classifyRunFailure(errorEvidence(parsed.errors, stderr), {
            exitCode,
            source: "process-exit",
          }),
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new RunFailureError(noAgentMessageFailure());
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
