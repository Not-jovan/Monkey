import type { ArkClient } from "./ark-client.js";
import { isArkConfigured, type AppConfig } from "./config.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

// The in-process AgentRunner: one model call, no child process, no event
// stream. It exists so the auditor executes through the same interface an
// Agent does — which is what lets the trace pipeline record an auditor's work
// as a first-class trace, and so lets that trace be audited in turn.
//
// Deliberately unlike ProcessRuntimeRunner in one respect: concurrent runs for
// the same agentId are allowed. A process runner rejects them because one
// workspace cannot host two CLI processes; this runner has no workspace, and
// the auditor fires seven checks for one step at once.
export class ArkRunner implements AgentRunner {
  private readonly active = new Map<string, Set<AbortController>>();

  constructor(
    private readonly client: ArkClient,
    private readonly config: AppConfig,
    private readonly maxTokens: number,
  ) {}

  async isAvailable(): Promise<boolean> {
    return isArkConfigured(this.config);
  }

  async cancel(agentId: string): Promise<boolean> {
    const controllers = this.active.get(agentId);
    if (!controllers || controllers.size === 0) return false;
    for (const controller of controllers) controller.abort();
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const model = request.model ?? this.config.arkModel;
    if (!model) {
      throw new Error(
        "ArkRunner needs a model: none was requested and ARK_MODEL is unset",
      );
    }

    const controller = new AbortController();
    const controllers = this.active.get(request.agentId) ?? new Set();
    controllers.add(controller);
    this.active.set(request.agentId, controllers);

    try {
      const result = await this.client.complete({
        model,
        system: request.system ?? "",
        user: request.prompt,
        maxTokens: this.maxTokens,
        signal: controller.signal,
      });
      // Reported even though the caller named the model: Ark resolves an
      // endpoint id to a concrete model, so what served the request is not
      // always what was asked for.
      const served = result.model ?? model;
      request.onModel?.(served);
      return {
        // Empty content is returned rather than thrown. The caller parses a
        // verdict out of it and already reports an unusable answer in its own
        // words; raising here would replace that with a vaguer one.
        output: result.content,
        // No conversation and no event stream: a completion is one exchange,
        // and there is nothing for a trace adapter to correlate on.
        threadId: null,
        usage: result.usage,
        model: served,
      };
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) this.active.delete(request.agentId);
    }
  }
}
