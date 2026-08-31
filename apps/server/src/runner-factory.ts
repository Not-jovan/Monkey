import { ProcessRuntimeRunner } from "./agent-runner.js";
import type { AppConfig } from "./config.js";
import { ContainerRuntimeRunner } from "./container-runtime-runner.js";
import type { RuntimeDefinition } from "./runtimes/types.js";
import type { AgentRunner } from "./types.js";

export function createRunner(
  config: AppConfig,
  runtime: RuntimeDefinition,
): AgentRunner {
  return config.runtimeProvider === "container"
    ? new ContainerRuntimeRunner(config, runtime)
    : new ProcessRuntimeRunner(config, runtime);
}
