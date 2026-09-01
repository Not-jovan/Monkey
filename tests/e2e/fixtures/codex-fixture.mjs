#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-fixture 1.0.0\n");
  process.exit(0);
}

const prompt = process.argv.at(-1) ?? "";
const threadId = "offline-e2e-thread";
const commandId = "offline-e2e-command";
const fileName = "trace-check.md";
const fileContents =
  "# Offline E2E proof\n\nThe credential-free runtime completed the requested task.\n";

await writeFile(fileName, fileContents, "utf8");

const events = [
  { type: "thread.started", thread_id: threadId },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: {
      id: "offline-e2e-reasoning",
      type: "reasoning",
      text: "I will inspect the workspace and create the requested proof file.",
      status: "completed",
    },
  },
  {
    type: "item.started",
    item: {
      id: commandId,
      type: "command_execution",
      command: "printf offline-e2e-proof > trace-check.md",
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: commandId,
      type: "command_execution",
      command: "printf offline-e2e-proof > trace-check.md",
      aggregated_output: "Created trace-check.md\nProcess exited with code 0",
      exit_code: 0,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "offline-e2e-message",
      type: "agent_message",
      text:
        "Created trace-check.md through the deterministic offline runtime for: " +
        prompt,
      status: "completed",
    },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 24,
      cached_input_tokens: 4,
      output_tokens: 18,
    },
  },
];

for (const event of events) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
