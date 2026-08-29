// Groups queued work into batches to keep the auditor under provider rate
// limits. PLAN_AUDITOR: a batch fires on whichever of bufferSize or
// bufferInterval comes first, and maxBatchesConcurrency is a hard ceiling on
// batches in flight.
//
// This replaces the auditor's single serial promise chain. Running audits
// concurrently is only correct because each step audit captures the intent
// version it is judging against *before* its model call — out-of-order
// completion therefore still reports the spec the step was actually judged
// against. Concurrency here before that change would have silently
// mis-attributed findings to whichever spec happened to be current last.

export interface BatchCallerOptions {
  // Queued tasks that trigger a batch immediately.
  bufferSize: number;
  // Seconds to wait before flushing a partial batch.
  bufferInterval: number;
  // Hard ceiling on batches running at once.
  maxBatchesConcurrency: number;
  log?: ((message: string, error?: unknown) => void) | undefined;
}

interface PendingTask {
  run: () => Promise<void>;
  settle: () => void;
}

export class BatchCaller {
  private pending: PendingTask[] = [];
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Resolves when nothing is queued and nothing is running. Rebuilt whenever
  // work arrives at an idle caller.
  private idlePromise: Promise<void> = Promise.resolve();
  private releaseIdle: (() => void) | null = null;
  private deepest = 0;

  constructor(private readonly options: BatchCallerOptions) {}

  // Named per PLAN_AUDITOR. Resolves when this task has run, so a caller that
  // needs its result can await it without knowing about batching.
  queue(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      this.markBusy();
      this.pending.push({ run: task, settle: resolve });
      this.deepest = Math.max(this.deepest, this.depth());
      if (this.pending.length >= this.options.bufferSize) {
        this.flush();
        return;
      }
      this.startTimer();
    });
  }

  // Queued but not yet finished, and the worst it has been. The auditor reports
  // this so the lag between an action and its finding is observable rather than
  // inferred from findings arriving late.
  depth() {
    return this.pending.length + this.inFlight;
  }

  backlog() {
    return { depth: this.depth(), deepest: this.deepest };
  }

  // Awaits everything queued and running. Tests use this instead of polling.
  idle() {
    return this.idlePromise;
  }

  // Sends whatever is queued now, subject to the concurrency ceiling.
  flush() {
    this.clearTimer();
    if (this.pending.length === 0) return;
    if (this.inFlight >= this.options.maxBatchesConcurrency) {
      // At the ceiling: a batch finishing will pick this up. Re-arm the timer
      // so a partial batch queued behind the ceiling still has a deadline.
      this.startTimer();
      return;
    }
    const batch = this.pending.splice(0, this.options.bufferSize);
    this.inFlight += 1;
    void this.runBatch(batch);
  }

  private async runBatch(batch: PendingTask[]) {
    try {
      await Promise.all(
        batch.map(async (task) => {
          try {
            await task.run();
          } catch (error) {
            // One failed audit must not take down the rest of its batch.
            this.options.log?.("batched audit task failed", error);
          } finally {
            task.settle();
          }
        }),
      );
    } finally {
      this.inFlight -= 1;
      if (this.pending.length > 0) {
        this.flush();
      } else if (this.inFlight === 0) {
        this.markIdle();
      }
    }
  }

  private startTimer() {
    if (this.timer !== null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.max(0, this.options.bufferInterval) * 1_000,
    );
    // Never hold the process open for a pending audit batch.
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private markBusy() {
    if (this.releaseIdle !== null) return;
    this.idlePromise = new Promise<void>((resolve) => {
      this.releaseIdle = resolve;
    });
  }

  private markIdle() {
    const release = this.releaseIdle;
    this.releaseIdle = null;
    release?.();
  }
}
