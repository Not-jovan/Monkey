import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  classifyRunFailure,
  RunFailureError,
  type RunFailure,
} from "./failures.js";
import { JsonStore } from "./store.js";
import type { TraceService } from "./traces/trace-service.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export interface InstructionsDrift {
  agentId: string;
  traceId: string;
  // "before" — the file already disagreed when the run began, so this run was
  // governed by a spec nobody approved and there is no telling who changed it.
  // "during" — it was intact at the start and had changed by the end, which
  // attributes the edit to this run.
  when: "before" | "during";
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  // Last model a run actually reported. Held in memory on purpose: it
  // describes the runtime running right now, and a restart can select a
  // different AGENT_RUNTIME, so a persisted value could outlive the runtime
  // it described.
  private lastRuntimeModel: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly traces?: TraceService,
    // Reports AGENTS.md no longer matching the agent's recorded instructions.
    // The file is inside the workspace and the default sandbox is
    // workspace-write, so the agent can edit the spec it is governed by.
    private readonly onInstructionsDrift?: (drift: InstructionsDrift) => void,
  ) {}

  private redact(text: string): string {
    return this.traces?.redactText(text) ?? text;
  }

  // Attribution before presentation. A sandbox denial, an unactivated Ark model
  // and a broken shell command all end a run, but only the last one says the
  // agent is what needs improving — so the layer is decided here rather than
  // left for a reader to infer from prose.
  private attribute(error: unknown, cancelled: boolean): RunFailure {
    const raw = error instanceof Error ? error.message : String(error);
    const failure =
      error instanceof RunFailureError
        ? error.failure
        : classifyRunFailure(raw, { cancelled });
    return { ...failure, detail: this.redact(failure.detail) };
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(
          409,
          "Stop the active run before editing this Agent",
        );
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined)
        agent.description = input.description.trim();
      if (input.instructions !== undefined)
        agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter(
        (item) => item.agentId !== id,
      );
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    // Record before cancel so an in-flight chat still has an active run to
    // attach to. Idle stop falls through to that agent's latest chat.
    this.traces?.onUserIntervention(id, "terminate");
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    // Supplied by the caller when the run has to be identified before it
    // starts — the intent classifier is queued against this id so the spec a
    // message establishes is settled before the run it governs executes.
    runId: string = randomUUID(),
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    // The raw prompt goes to Codex; every stored or returned copy is masked so
    // pasted credentials never persist in the transcript.
    const redactedPrompt = this.redact(prompt);
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt: redactedPrompt,
      output: null,
      error: null,
      failure: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: redactedPrompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    this.traces?.onRunStart(agentAtStart, { id: runId, prompt });
    const execution = this.executeRun(agentAtStart, run, prompt);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const runtimeLabel =
      this.config.agentRuntime === "claude-code" ? "Claude Code" : "Codex CLI";
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      agentRuntime: this.config.agentRuntime,
      // What the Agent itself runs on, which is not always arkModel: Ark
      // powers the audit models for every runtime, but only Codex's Agent.
      // Claude Code resolves its model from the account at run time, so this
      // stays null until a run has reported one.
      agentModel:
        this.lastRuntimeModel ??
        (this.config.agentRuntime === "codex"
          ? this.config.arkModel || null
          : null),
      runtimeAvailable: await this.runner.isAvailable(),
      // Codex's inner sandbox; meaningless for other runtimes, so the UI
      // only surfaces it when Codex is the selected runtime.
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? runtimeLabel + " in " + this.config.containerEngine + " Runtime"
          : runtimeLabel + " in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    rawPrompt = run.prompt,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    // Checked either side of the run so an edit can be attributed. Reporting is
    // best-effort: a workspace that cannot be read is not a reason to refuse to
    // run, and the drift report is a finding, not a gate.
    const driftedBefore = await this.checkInstructionsDrift(
      agentAtStart,
      run.id,
      "before",
    );
    // Set by onModel below, which fires before the turn does any work — so a
    // run that fails still knows what it was running on.
    let observedModel: string | null = null;

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: rawPrompt,
        threadId: agentAtStart.codexThreadId,
        runId: run.id,
        redact: (text) => this.redact(text),
        onModel: (model) => {
          observedModel = model;
          this.lastRuntimeModel = model;
        },
        onThread: (threadId) => this.traces?.onConversation(run.id, threadId),
        onEvent: (event) => this.traces?.onRunnerEvent(run.id, event),
      });
      const completedAt = now();
      const safeOutput = this.redact(result.output);
      if (result.model) {
        observedModel = result.model;
        this.lastRuntimeModel = result.model;
      }
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find(
          (item) => item.id === agentAtStart.id,
        );
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = safeOutput;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: safeOutput,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      this.traces?.onRunEnd(run.id, {
        status: "completed",
        output: safeOutput,
        model: observedModel,
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const failure = this.attribute(error, cancelled);
      const message = this.redact(
        error instanceof Error ? error.message : String(error),
      );
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find(
          (item) => item.id === agentAtStart.id,
        );
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.failure = failure;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      this.traces?.onRunEnd(run.id, {
        status: cancelled ? "cancelled" : "failed",
        error: message,
        failure,
        model: observedModel,
      });
    } finally {
      // Only worth reporting when the file was intact beforehand: a run that
      // started with drift has already been reported, and re-reporting it every
      // run would bury the one case that names a culprit.
      if (!driftedBefore) {
        await this.checkInstructionsDrift(agentAtStart, run.id, "during");
      }
    }
  }

  // Returns whether the file disagreed, so the caller can tell "already drifted"
  // from "this run changed it".
  private async checkInstructionsDrift(
    agent: Agent,
    traceId: string,
    when: InstructionsDrift["when"],
  ): Promise<boolean> {
    if (!this.onInstructionsDrift) return false;
    try {
      if (!(await this.workspaces.instructionsDrifted(agent))) return false;
      this.onInstructionsDrift({ agentId: agent.id, traceId, when });
      return true;
    } catch {
      // Never let an unreadable workspace take a run down with it.
      return false;
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(
          409,
          "Stop the active run before starting this Agent",
        );
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
