import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunTranscript, attachFailureTranscript } from "./run-transcript.js";

async function scratchDir() {
  return mkdtemp(path.join(tmpdir(), "run-transcript-"));
}

describe("RunTranscript", () => {
  it("writes stdout and stderr for a failed run and points the error at the file", async () => {
    const dataDirectory = await scratchDir();
    const transcript = new RunTranscript();
    transcript.recordStdout('{"type":"assistant","error":"authentication_failed"}\n');
    transcript.recordStderr("a warning\n");
    const error = new Error("exited with code 1: subtype=error_during_execution");

    await attachFailureTranscript(transcript, error, {
      dataDirectory,
      runtimeId: "claude-code",
      argv: ["claude", "-p", "hello"],
      runId: "run-1",
    });

    expect(error.message).toContain("full transcript:");
    const written = await readFile(path.join(dataDirectory, "run-logs", "run-1.log"), "utf8");
    expect(written).toContain("authentication_failed");
    expect(written).toContain("a warning");
    expect(written).toContain("claude-code");
    expect(written).toContain("subtype=error_during_execution");
  });

  it("masks secrets before the transcript reaches disk", async () => {
    const dataDirectory = await scratchDir();
    const transcript = new RunTranscript();
    transcript.recordStdout("using sk-ant-super-secret-value to authenticate\n");
    const error = new Error("boom");

    await attachFailureTranscript(transcript, error, {
      dataDirectory,
      runtimeId: "claude-code",
      argv: ["claude", "-p", "sk-ant-super-secret-value"],
      runId: "run-2",
      redact: (text) => text.replaceAll("sk-ant-super-secret-value", "***"),
    });

    const written = await readFile(path.join(dataDirectory, "run-logs", "run-2.log"), "utf8");
    expect(written).not.toContain("sk-ant-super-secret-value");
    expect(written).toContain("***");
  });

  it("does nothing without a run id, leaving the error untouched", async () => {
    const dataDirectory = await scratchDir();
    const error = new Error("boom");
    await attachFailureTranscript(new RunTranscript(), error, {
      dataDirectory,
      runtimeId: "codex",
      argv: ["codex"],
    });
    expect(error.message).toBe("boom");
  });

  // A diagnostic aid must never be able to mask the failure it describes.
  it("never throws when the transcript cannot be written", async () => {
    // A regular file standing where the data directory should be: creating a
    // directory under it fails on every platform. `/proc/...` only fails on
    // Linux — on Windows it resolves to a perfectly writable C:\proc\..., so
    // the write succeeded and this test asserted the opposite of what ran.
    const blocker = path.join(await scratchDir(), "not-a-directory");
    await writeFile(blocker, "", "utf8");
    const error = new Error("boom");
    await expect(
      attachFailureTranscript(new RunTranscript(), error, {
        dataDirectory: blocker,
        runtimeId: "codex",
        argv: ["codex"],
        runId: "run-3",
      }),
    ).resolves.toBeUndefined();
    expect(error.message).toBe("boom");
  });

  it("keeps only the tail of runaway output", async () => {
    const dataDirectory = await scratchDir();
    const transcript = new RunTranscript();
    transcript.recordStdout("EARLY_MARKER" + "x".repeat(400_000) + "LATE_MARKER");
    const error = new Error("boom");

    await attachFailureTranscript(transcript, error, {
      dataDirectory,
      runtimeId: "codex",
      argv: ["codex"],
      runId: "run-4",
    });

    const written = await readFile(path.join(dataDirectory, "run-logs", "run-4.log"), "utf8");
    expect(written).toContain("LATE_MARKER");
    expect(written).not.toContain("EARLY_MARKER");
  });
});
