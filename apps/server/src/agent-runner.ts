import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError, runFailureDetail } from "./errors.js";
import {
  classifyRunFailure,
  noAgentMessageFailure,
  RunFailureError,
} from "./failures.js";
import { RunTranscript, attachFailureTranscript } from "./middlewares/run-transcript/index.js";
import type { ParsedEvents, RuntimeDefinition } from "./runtimes/types.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

const execFileAsync = promisify(execFile);

// Generic across every Agent runtime (Codex, Claude Code, ...): all of the
// spawn/timeout/cancel control flow lives here exactly once, driven by a
// RuntimeDefinition for what differs (binary, argv, env, stdout parsing).
export class ProcessRuntimeRunner implements AgentRunner {
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

  constructor(
    private readonly config: AppConfig,
    private readonly runtime: RuntimeDefinition,
    private readonly collectorToken: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.runtime.bin(this.config), ["--version"], {
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
      throw new Error("Agent already has an active " + this.runtime.id + " process");
    }

    const args = this.runtime.buildArgs(request, request.workspacePath, this.config);
    const transcript = new RunTranscript();
    const child = spawn(this.runtime.bin(this.config), args, {
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
      model: null,
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let modelReported = false;
    // Seeded from the resumed id: onRunStart already bound that one, so
    // re-announcing it would be noise. A runtime that mints a fresh id on
    // resume still gets announced, because the value differs.
    let reportedThreadId = request.threadId;

    // Both ids are resolved by the runtime mid-run rather than known up
    // front, and both have a caller waiting on them — the sidebar for the
    // model, the trace pipeline for the conversation. Announced from one
    // place so neither can be missed on a stream that ends without a
    // trailing newline.
    const reportRuntimeIds = () => {
      if (parsed.model && !modelReported) {
        modelReported = true;
        request.onModel?.(parsed.model);
      }
      if (parsed.threadId && parsed.threadId !== reportedThreadId) {
        reportedThreadId = parsed.threadId;
        request.onThread?.(parsed.threadId);
      }
    };

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        transcript.recordStdout(chunk.toString("utf8"));
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          this.runtime.parseEventLine(line, parsed, request.onEvent);
          reportRuntimeIds();
        }
      } else {
        transcript.recordStderr(chunk.toString("utf8"));
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
        this.runtime.parseEventLine(stdout.trim(), parsed, request.onEvent);
        reportRuntimeIds();
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
          classifyRunFailure(runFailureDetail(parsed.errors, stderr), {
            exitCode,
            source: "process-exit",
          }),
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        // A runtime can report a failure and still exit 0 (Claude Code sets
        // is_error on the result event). Attribute it from what it reported
        // rather than falling through to the generic "no message" verdict,
        // which would blame the agent for a provider or policy failure.
        if (parsed.errors.length > 0) {
          throw new RunFailureError(
            classifyRunFailure(runFailureDetail(parsed.errors, stderr), {
              exitCode,
            }),
          );
        }
        throw new RunFailureError(noAgentMessageFailure());
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
        model: parsed.model,
      };
    } catch (error) {
      // A cancellation is a user action, not a fault worth a transcript.
      if (!(error instanceof RunCancelledError)) {
        await attachFailureTranscript(transcript, error, {
          dataDirectory: this.config.dataDirectory,
          runtimeId: this.runtime.id,
          argv: [this.runtime.bin(this.config), ...args],
          runId: request.runId,
          redact: request.redact,
        });
      }
      throw error;
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
      NO_COLOR: "1",
      ...this.runtime.processEnv(this.config, this.collectorToken),
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
