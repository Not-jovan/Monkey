import path from "node:path";
import type { AppConfig } from "../../config.js";
import { IntentCorrectionStore } from "./correction-store.js";

// The intent middleware owns nothing about what an Agent is for — that lives
// on the Agent's instructions, which the auditor's reducer rebases onto every
// run. What it owns is the record of operators changing that spec in response
// to audit findings: who corrected what, on which evidence, and what the spec
// said beforehand.
export async function createIntentMiddleware(input: {
  config: AppConfig;
  onStoreError: (message: string, error?: unknown) => void;
}) {
  const correctionStore = new IntentCorrectionStore(
    path.join(input.config.dataDirectory, "intent-corrections"),
    input.onStoreError,
  );
  await correctionStore.initialize();

  return {
    correctionStore,
    flush: () => correctionStore.flush(),
  };
}

export type IntentMiddleware = Awaited<
  ReturnType<typeof createIntentMiddleware>
>;

export { registerIntentRoutes } from "./routes.js";
export { describeIntent, type IntentState } from "./intent-model.js";
export { IntentReducer } from "./intent-reducer.js";
export {
  IntentCorrectionStore,
  type IntentCorrection,
} from "./correction-store.js";
