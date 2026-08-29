import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Bounded so a runaway runtime cannot exhaust memory or disk; the tail is the
// useful half of a failure anyway.
const TAIL_BYTES = 256 * 1024;

function keepTail(text: string): string {
  return text.length > TAIL_BYTES ? text.slice(-TAIL_BYTES) : text;
}

/**
 * Captures a Runtime's raw stdout/stderr so a failed run can be diagnosed
 * after the fact.
 *
 * This exists because the structured event stream is not a reliable carrier
 * of failure detail: Claude Code reports `subtype: "error_during_execution"`
 * with no message on the result event, and writes nothing at all to stderr
 * (verified against 2.1.250) — the actual reason appears on an *earlier*
 * event. Rather than guess which field each runtime uses, keep the whole
 * stream and let a human read it.
 */
export class RunTranscript {
  private stdout = "";
  private stderr = "";

  recordStdout(chunk: string): void {
    this.stdout = keepTail(this.stdout + chunk);
  }

  recordStderr(chunk: string): void {
    this.stderr = keepTail(this.stderr + chunk);
  }

  /**
   * Writes the transcript for a failed run and returns its path, or null if
   * it could not be written. Never throws: a diagnostic aid must not be able
   * to mask the failure it is describing.
   */
  async persist(options: {
    dataDirectory: string;
    runId: string;
    runtimeId: string;
    argv: string[];
    error: string;
    redact?: (text: string) => string;
  }): Promise<string | null> {
    const redact = options.redact ?? ((text: string) => text);
    const directory = path.join(options.dataDirectory, "run-logs");
    const filePath = path.join(directory, options.runId + ".log");
    const body = [
      "# Runtime failure transcript",
      "runtime:  " + options.runtimeId,
      "runId:    " + options.runId,
      "recorded: " + new Date().toISOString(),
      // argv can carry the prompt, so it goes through the same masking as
      // everything else the platform persists.
      "argv:     " + redact(options.argv.join(" ")),
      "error:    " + redact(options.error),
      "",
      "## stdout",
      redact(this.stdout) || "(empty)",
      "",
      "## stderr",
      redact(this.stderr) || "(empty)",
      "",
    ].join("\n");

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(filePath, body, { encoding: "utf8", mode: 0o600 });
      return filePath;
    } catch {
      return null;
    }
  }
}

/**
 * Persists the transcript for a failed run and points the thrown error at it,
 * so the message surfaced in the UI carries a path to the full output.
 * Shared by both runners; a no-op when the caller supplied no run id.
 */
export async function attachFailureTranscript(
  transcript: RunTranscript,
  error: unknown,
  options: {
    dataDirectory: string;
    runtimeId: string;
    argv: string[];
    runId?: string | undefined;
    redact?: ((text: string) => string) | undefined;
  },
): Promise<void> {
  if (!options.runId || !(error instanceof Error)) return;
  const logPath = await transcript.persist({
    dataDirectory: options.dataDirectory,
    runId: options.runId,
    runtimeId: options.runtimeId,
    argv: options.argv,
    error: error.message,
    ...(options.redact ? { redact: options.redact } : {}),
  });
  if (logPath) {
    error.message += " · full transcript: " + logPath;
  }
}
