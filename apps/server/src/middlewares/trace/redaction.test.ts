import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexRuntime } from "../../runtimes/codex.js";
import { createRedactor, maskSecret } from "./redaction.js";
import { TraceService } from "./trace-service.js";
import { TraceStore } from "./trace-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("maskSecret", () => {
  it("partially masks long secrets and fully masks short ones", () => {
    expect(maskSecret("abcdef123456789xyz")).toBe("abc************xyz");
    expect(maskSecret("shortkey")).toBe("******");
  });
});

describe("createRedactor", () => {
  const arkKey = "ark-EXAMPLE-FAKE-TOKEN-FOR-UNIT-TESTS-001";
  const redactor = createRedactor([arkKey, "hunter2-hunter2"]);

  it("masks configured values everywhere and prefers the longest match", () => {
    const repeated = redactor.redactText(arkKey + " and again " + arkKey);
    expect(repeated).not.toContain(arkKey);
    expect(repeated.match(/ark\*+/g)).toHaveLength(2);

    const layered = createRedactor(["abcdefgh", "abcdefgh-extended-secret"]);
    expect(layered.redactText("abcdefgh-extended-secret")).not.toContain(
      "extended",
    );
  });

  it("ignores configured values that are too short or multiline", () => {
    const noisy = createRedactor(["true", "line1\nline2"]);
    expect(noisy.redactText("value is true and line1\nline2")).toBe(
      "value is true and line1\nline2",
    );
  });

  it("masks bearer tokens and credential shapes shared with detection", () => {
    const values = [
      "ghp_exampleexampleexample",
      "sk_live_exampleexample",
      "sk-ant-exampleexampleexampleexample",
      "sk-exampleexampleexample",
      "ark-example-example-example",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJexampleexample.example.example",
      "postgres://user:password@example.com/db",
    ];
    for (const value of values) {
      expect(redactor.redactText("value " + value + " end")).not.toContain(
        value,
      );
    }

    const bearer = "abcdefgh12345678TOKEN";
    const masked = redactor.redactText("Authorization: Bearer " + bearer);
    expect(masked).toContain("Bearer ");
    expect(masked).not.toContain(bearer);
  });

  it("redacts nested strings without changing non-string values", () => {
    const masked = redactor.redactDeep({
      count: 3,
      ok: true,
      output: "leaked " + arkKey,
      steps: [{ note: arkKey }, { note: "clean" }],
    });
    expect(masked.count).toBe(3);
    expect(masked.ok).toBe(true);
    expect(masked.output).not.toContain(arkKey);
    expect(masked.steps[0]?.note).not.toContain(arkKey);
    expect(masked.steps[1]?.note).toBe("clean");
  });

  it("leaves ordinary URLs intact", () => {
    const url = "https://example.com:8080/health";
    expect(redactor.redactText("GET " + url)).toContain(url);
  });
});

describe("TraceService redaction boundary", () => {
  it("keeps plaintext secrets out of persisted and API-facing traces", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trace-redaction-"));
    temporaryDirectories.push(directory);
    const secret = "ark-INTEGRATION-FAKE-SECRET-0001";
    const store = new TraceStore(directory);
    await store.initialize();
    const service = new TraceService(
      store,
      createRedactor([secret]),
      codexRuntime.trace,
      () => new Date("2026-08-31T00:00:00.000Z"),
    );

    service.onRunStart(
      {
        id: "agent-redaction",
        name: "Redaction test",
        instructions: "Test redaction.",
        codexThreadId: null,
      },
      { id: "run-redaction", prompt: "Use " + secret + " safely." },
    );
    service.onRunnerEvent("run-redaction", {
      type: "item.started",
      item: {
        id: "tool-1",
        type: "command_execution",
        command: "echo " + secret,
        nested: { credential: secret },
      },
    });
    service.onRunnerEvent("run-redaction", {
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "command_execution",
        command: "echo " + secret,
        aggregated_output: "output=" + secret,
        exit_code: 1,
        status: "failed",
      },
    });
    service.onRunEnd("run-redaction", {
      status: "failed",
      error: "provider returned " + secret,
    });
    await store.flush();

    const persisted = await readFile(
      path.join(directory, "run-redaction.json"),
      "utf8",
    );
    const apiFacing = JSON.stringify(store.get("run-redaction"));
    expect(persisted).not.toContain(secret);
    expect(apiFacing).not.toContain(secret);
    expect(persisted).toContain("ark");
    expect(persisted).toContain("***");
  });
});
