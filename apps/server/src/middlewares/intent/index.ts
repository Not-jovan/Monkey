import path from "node:path";
import type { ArkClient } from "../../ark-client.js";
import type { AppConfig } from "../../config.js";
import { describeIntent } from "./intent-model.js";
import { IntentService } from "./intent-service.js";
import { IntentStore } from "./intent-store.js";

export async function createIntentMiddleware(input: {
  config: AppConfig;
  client: ArkClient;
  enabled: boolean;
  onStoreError: (message: string, error?: unknown) => void;
  log: (message: string, error?: unknown) => void;
}) {
  const intentStore = new IntentStore(
    path.join(input.config.dataDirectory, "intent"),
    input.onStoreError,
  );
  await intentStore.initialize();
  const intentService = new IntentService({
    store: intentStore,
    client: input.client,
    model: input.config.auditIntentModel,
    enabled: input.enabled,
    log: input.log,
  });

  return {
    intentStore,
    intentService,
    // The standing spec, handed to the runtime so the agent works under it.
    describeFor: (agentId: string) => {
      const intent = intentService.state(agentId);
      return intent.objective.length > 0 || intent.extended.length > 0
        ? describeIntent(intent)
        : "";
    },
    flush: () => intentStore.flush(),
  };
}

export type IntentMiddleware = Awaited<
  ReturnType<typeof createIntentMiddleware>
>;

export { registerIntentRoutes } from "./routes.js";
export { IntentService, type ClassifyFailure } from "./intent-service.js";
export { IntentStore } from "./intent-store.js";
export { describeIntent, type IntentState } from "./intent-model.js";
