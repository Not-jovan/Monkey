import { describe, expect, it } from "vitest";
import { BatchCaller } from "./batch-caller.js";

const tick = (ms = 0) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), ms));

describe("BatchCaller", () => {
  it("fires a batch as soon as the buffer is full, without waiting for the interval", async () => {
    const ran: number[] = [];
    // A long interval, so anything that runs did so because the buffer filled.
    const caller = new BatchCaller({
      bufferSize: 3,
      bufferInterval: 60,
      maxBatchesConcurrency: 1,
    });

    caller.queue(async () => void ran.push(1));
    caller.queue(async () => void ran.push(2));
    expect(ran).toEqual([]);

    caller.queue(async () => void ran.push(3));
    await caller.idle();
    expect(ran.sort()).toEqual([1, 2, 3]);
  });

  it("flushes a partial batch once the interval elapses", async () => {
    const ran: number[] = [];
    const caller = new BatchCaller({
      bufferSize: 10,
      bufferInterval: 0.02,
      maxBatchesConcurrency: 1,
    });

    caller.queue(async () => void ran.push(1));
    expect(ran).toEqual([]);

    await caller.idle();
    expect(ran).toEqual([1]);
  });

  it("never exceeds maxBatchesConcurrency", async () => {
    let running = 0;
    let peak = 0;
    const caller = new BatchCaller({
      bufferSize: 1,
      bufferInterval: 0.01,
      maxBatchesConcurrency: 2,
    });

    // bufferSize 1 means every task is its own batch, so the ceiling is the
    // only thing keeping these from all running at once.
    const tasks = Array.from({ length: 8 }, () =>
      caller.queue(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await tick(5);
        running -= 1;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it("resolves the caller's promise even when the task throws", async () => {
    const failures: unknown[] = [];
    const caller = new BatchCaller({
      bufferSize: 2,
      bufferInterval: 0.01,
      maxBatchesConcurrency: 1,
      log: (_message, error) => failures.push(error),
    });

    let secondRan = false;
    // One failing audit must not strand its own promise nor block the rest of
    // its batch: the auditor is advisory and a failure here cannot stall a run.
    const first = caller.queue(async () => {
      throw new Error("audit exploded");
    });
    const second = caller.queue(async () => void (secondRan = true));

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(secondRan).toBe(true);
    expect(failures).toHaveLength(1);
  });

  it("reports depth and the high-water mark", async () => {
    const caller = new BatchCaller({
      bufferSize: 50,
      bufferInterval: 0.01,
      maxBatchesConcurrency: 1,
    });

    caller.queue(async () => tick(1));
    caller.queue(async () => tick(1));
    expect(caller.depth()).toBe(2);

    await caller.idle();
    expect(caller.depth()).toBe(0);
    // Retained after draining: the lag is worth knowing about after the fact.
    expect(caller.backlog().deepest).toBe(2);
  });

  it("keeps draining when more work arrives than one batch can hold", async () => {
    const ran: number[] = [];
    const caller = new BatchCaller({
      bufferSize: 2,
      bufferInterval: 0.01,
      maxBatchesConcurrency: 1,
    });

    const tasks = Array.from({ length: 7 }, (_unused, index) =>
      caller.queue(async () => void ran.push(index)),
    );
    await Promise.all(tasks);

    expect(ran).toHaveLength(7);
    expect([...ran].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
