import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError, runFailureDetail } from "./errors.js";
import {
  classifyRunFailure,
  noAgentMessageFailure,
  RunFailureError,
} from "./failures.js";
import { RunTranscript, attachFailureTranscript } from "./middlewares/run-transcript/index.js";
import { startRuntimeEventPipeline } from "./runtime-event-scraper.js";
import type { ParsedEvents, RuntimeDefinition } from "./runtimes/types.js";
import type { AgentRunner, RunUsage, RunnerRequest, RunnerResult } from "./types.js";

const execFileAsync = promisify(execFile);

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

// Generic across every Agent runtime: bind mounts, resource limits, and
// labeling are identical regardless of which runtime is running; only the
// env vars forwarded, the home-directory mount, the container entrypoint,
// and its argv come from the RuntimeDefinition.
export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
  runtime: RuntimeDefinition,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const env = runtime.processEnv(config);
  // The home-dir var gets its own explicit --env below, pointed at the
  // container-side mount path rather than the host path processEnv
  // returns; every other var is forwarded by name from the docker/podman
  // CLI's own environment (which childEnvironment() below populates with
  // the same processEnv values).
  const passthroughEnvNames = Object.keys(env).filter(
    (key) => key !== runtime.homeEnvVar,
  );
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    // Lets the Runtime reach the control plane's OTel collector on Linux
    // engines; Docker Desktop resolves the alias natively and ignores this.
    "--add-host",
    "host.docker.internal:host-gateway",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    ...passthroughEnvNames.flatMap((envName) => ["--env", envName]),
    "--env",
    runtime.homeEnvVar + "=/runtime-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + runtime.homeDir(config) + ",dst=/runtime-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    runtime.bin(config),
    ...runtime.buildArgs(request, "/workspace", config),
  ];
}

export class ContainerRuntimeRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(
    private readonly config: AppConfig,
    private readonly runtime: RuntimeDefinition,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error(
        "Agent already has an active " + this.runtime.id + " Runtime container",
      );
    }

    const argv = buildContainerRunArgs(
      request,
      this.config,
      this.runtime,
    );
    const transcript = new RunTranscript();
    const child = spawn(this.config.containerEngine, argv, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null as RunUsage | null,
      errors: [],
      model: null,
    };
    const eventPipeline =
      request.runId && request.onEvent
        ? await startRuntimeEventPipeline({
            dataDirectory: this.config.dataDirectory,
            runId: request.runId,
            onEvent: request.onEvent,
            onProblem: request.onEventStreamProblem,
            isTerminalEvent: this.runtime.isTerminalEvent,
            disrupted: request.eventPipeline?.disrupted,
          })
        : null;
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
        void this.removeContainer(active);
        return;
      }
      if (target === "stdout") {
        const text = chunk.toString("utf8");
        transcript.recordStdout(text);
        eventPipeline?.record(text);
        stdout += text;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          this.runtime.parseEventLine(
            line,
            parsed,
            eventPipeline ? undefined : request.onEvent,
          );
          reportRuntimeIds();
        }
      } else {
        transcript.recordStderr(chunk.toString("utf8"));
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
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
        this.runtime.parseEventLine(
          stdout.trim(),
          parsed,
          eventPipeline ? undefined : request.onEvent,
        );
        reportRuntimeIds();
      }
      await eventPipeline?.close();
      if (active.cancelled) throw new RunCancelledError();
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
      await eventPipeline?.close();
      // A cancellation is a user action, not a fault worth a transcript.
      if (!(error instanceof RunCancelledError)) {
        await attachFailureTranscript(transcript, error, {
          dataDirectory: this.config.dataDirectory,
          runtimeId: this.runtime.id,
          argv,
          runId: request.runId,
          redact: request.redact,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      NO_COLOR: "1",
      ...this.runtime.processEnv(this.config),
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
