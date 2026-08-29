export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

// How many distinct reported errors to keep in a failure message. A runtime
// often reports the real cause on an earlier event and a generic code last
// (Claude Code ends with a bare "error_during_execution"), so keeping only
// the final one throws away the useful half.
const MAX_REPORTED_ERRORS = 3;
const STDERR_TAIL = 600;

/**
 * Builds the detail for a failed Runtime exit.
 *
 * Combines rather than picks: the most recent few distinct reported errors
 * *and* stderr, because either can be the only place the reason appears.
 * Written with explicit emptiness checks rather than `??` chaining — `??`
 * only falls through on null/undefined, so an empty stderr string used to
 * win over the fallback and produce a bare "exited with code 1:" message.
 */
export function runFailureDetail(
  errors: readonly string[],
  stderr: string,
): string {
  const reported = [...new Set(errors.map((entry) => entry.trim()).filter(Boolean))];
  const parts = reported.slice(-MAX_REPORTED_ERRORS);

  const trimmedStderr = stderr.trim();
  if (trimmedStderr) {
    const tail =
      trimmedStderr.length > STDERR_TAIL
        ? trimmedStderr.slice(-STDERR_TAIL)
        : trimmedStderr;
    parts.push("stderr: " + tail);
  }

  return parts.length > 0 ? parts.join(" · ") : "No error detail";
}
