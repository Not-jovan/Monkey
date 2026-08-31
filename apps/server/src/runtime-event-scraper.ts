import { watch, type FSWatcher } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeEventStreamProblem } from "./types.js";

const POLL_INTERVAL_MS = 1_000;

const scrapeStateSchema = z.object({
  ptr: z.number().int().min(0),
  done: z.boolean(),
  partialLine: z.string(),
});

const runtimeEventSchema = z.object({ type: z.string().min(1) }).passthrough();

type ScrapeState = z.infer<typeof scrapeStateSchema>;
type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

class MockTracerDisruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockTracerDisruptionError";
  }
}

function emptyScrapeState(): ScrapeState {
  return { ptr: 0, done: false, partialLine: "" };
}

function statePathFor(filePath: string): string {
  return path.join(path.dirname(filePath), "scrape-state.json");
}

export function runtimeEventDirectory(
  dataDirectory: string,
  runId: string,
): string {
  return path.join(dataDirectory, "runtime-events", runId);
}

export function runtimeEventFilePath(
  dataDirectory: string,
  runId: string,
): string {
  return path.join(runtimeEventDirectory(dataDirectory, runId), "events.jsonl");
}

export function runtimeEventStatePath(
  dataDirectory: string,
  runId: string,
): string {
  return path.join(runtimeEventDirectory(dataDirectory, runId), "scrape-state.json");
}

class ScrapeStateStore {
  private readonly states = new Map<string, ScrapeState>();
  private readonly queues = new Map<string, Promise<void>>();

  async load(filePath: string): Promise<{ state: ScrapeState; exists: boolean }> {
    const cached = this.states.get(filePath);
    if (cached) {
      return {
        state: { ...cached },
        exists: true,
      };
    }
    try {
      const stored = scrapeStateSchema.parse(
        JSON.parse(await readFile(statePathFor(filePath), "utf8")),
      );
      this.states.set(filePath, stored);
      return {
        state: { ...stored },
        exists: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: emptyScrapeState(), exists: false };
      }
      throw error;
    }
  }

  async save(filePath: string, state: ScrapeState): Promise<void> {
    const next = { ...state };
    this.states.set(filePath, next);
    const file = statePathFor(filePath);
    const queued = (this.queues.get(filePath) ?? Promise.resolve()).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = file + ".tmp";
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, file);
    });
    this.queues.set(filePath, queued.catch(() => undefined));
    await queued;
  }
}

async function readRange(
  filePath: string,
  startByte: number,
  endByte: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const length = endByte - startByte;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, startByte);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface RuntimeEventScraperOptions {
  runId: string;
  filePath: string;
  onEvent: (event: Record<string, unknown>) => void | Promise<void>;
  onProblem?: ((problem: RuntimeEventStreamProblem) => void | Promise<void>) | undefined;
  isTerminalEvent: (event: Record<string, unknown>) => boolean;
  disrupted: boolean;
}

class RuntimeEventScraper {
  private readonly stateStore = new ScrapeStateStore();
  private readonly onProblem;
  private watcher: FSWatcher | null = null;
  private interval: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private closed = false;

  constructor(private readonly options: RuntimeEventScraperOptions) {
    this.onProblem = options.onProblem;
  }

  async start(): Promise<void> {
    const existing = await this.stateStore.load(this.options.filePath);
    if (!existing.exists) {
      await this.stateStore.save(this.options.filePath, existing.state);
    }

    try {
      await this.scrape();
    } catch (error) {
      if (!(error instanceof MockTracerDisruptionError)) throw error;
    }

    const current = await this.stateStore.load(this.options.filePath);
    if (current.state.done || this.stopped) {
      await this.close();
      return;
    }

    this.watcher = watch(this.options.filePath, () => {
      void this.enqueueScrape();
    });
    this.interval = setInterval(() => {
      void this.enqueueScrape();
    }, POLL_INTERVAL_MS);
    this.interval.unref();
  }

  recordWriteFailure(error: unknown): void {
    void this.markCorrupted(
      "Runtime event file could not be written: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  async flush(): Promise<void> {
    await this.enqueueScrape();
    await this.queue;
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.queue;
      return;
    }
    this.closed = true;
    this.stopWatching();
    await this.queue;
  }

  private async enqueueScrape(): Promise<void> {
    if (this.stopped) return;
    const queued = this.queue.then(() => this.scrape());
    this.queue = queued.catch(() => undefined);
    await queued;
  }

  private async scrape(): Promise<void> {
    const loaded = await this.stateStore.load(this.options.filePath);
    const state = loaded.state;

    if (state.done || this.stopped) return;
    if (this.options.disrupted) {
      const reason =
        "MOCK_DISRUPT_TRACER is enabled, so the runtime event scraper aborted intentionally.";
      await this.markCorrupted(reason);
      state.done = true;
      await this.stateStore.save(this.options.filePath, state);
      throw new MockTracerDisruptionError(reason);
    }

    const fileInfo = await stat(this.options.filePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!fileInfo) return;

    const fileSize = fileInfo.size;
    if (fileSize < state.ptr) {
      await this.markReset(state);
      return;
    }
    if (fileSize === state.ptr) return;

    const bytes = await readRange(this.options.filePath, state.ptr, fileSize);
    let text = state.partialLine + bytes.toString("utf8");
    state.partialLine = "";

    const lines = text.split("\n");
    const completeLines = text.endsWith("\n")
      ? lines
      : (() => {
          state.partialLine = lines.pop() ?? "";
          return lines;
        })();

    for (const line of completeLines) {
      const eventSize = Buffer.byteLength(line, "utf8") + Buffer.byteLength("\n", "utf8");
      if (line.trim().length === 0) {
        state.ptr += eventSize;
        await this.stateStore.save(this.options.filePath, state);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        await this.markMalformed(
          "Malformed runtime JSONL event: " +
            (error instanceof Error ? error.message : String(error)),
          line,
          state,
        );
        return;
      }

      const event = runtimeEventSchema.safeParse(parsed);
      if (!event.success) {
        await this.markMalformed("Runtime JSONL event failed schema validation", line, state);
        return;
      }

      try {
        await this.options.onEvent(event.data);
      } catch {
        return;
      }
      state.ptr += eventSize;

      if (this.options.isTerminalEvent(event.data)) {
        state.done = true;
        await this.stateStore.save(this.options.filePath, state);
        this.stopWatching();
        return;
      }

      await this.stateStore.save(this.options.filePath, state);
    }

    await this.stateStore.save(this.options.filePath, state);
  }

  private async markReset(state: ScrapeState): Promise<void> {
    await this.markCorrupted("Runtime event file was truncated or replaced");
    state.done = true;
    await this.stateStore.save(this.options.filePath, state);
    this.stopWatching();
  }

  private async markMalformed(
    reason: string,
    line: string,
    state: ScrapeState,
  ): Promise<void> {
    await this.markCorrupted(reason, line);
    state.done = true;
    await this.stateStore.save(this.options.filePath, state);
    this.stopWatching();
  }

  private async markCorrupted(reason: string, line?: string): Promise<void> {
    this.stopWatching();
    await this.onProblem?.({
      runId: this.options.runId,
      filePath: this.options.filePath,
      reason,
      ...(line !== undefined ? { line } : {}),
    });
  }

  private stopWatching(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

class RuntimeEventFile {
  private queue: Promise<void> = Promise.resolve();
  private sawOutput = false;
  private endsWithNewline = true;

  constructor(private readonly filePath: string) {}

  static async create(dataDirectory: string, runId: string): Promise<RuntimeEventFile> {
    const directory = runtimeEventDirectory(dataDirectory, runId);
    await mkdir(directory, { recursive: true });
    const filePath = runtimeEventFilePath(dataDirectory, runId);
    await writeFile(filePath, "", {
      encoding: "utf8",
      mode: 0o600,
    });
    return new RuntimeEventFile(filePath);
  }

  append(chunk: string): Promise<void> {
    if (chunk.length === 0) return Promise.resolve();
    this.sawOutput = true;
    this.endsWithNewline = chunk.endsWith("\n");
    const queued = this.queue.then(() =>
      appendFile(this.filePath, chunk, { encoding: "utf8" }),
    );
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  async close(): Promise<void> {
    await this.queue;
    if (!this.sawOutput || this.endsWithNewline) return;
    await appendFile(this.filePath, "\n", { encoding: "utf8" });
    this.endsWithNewline = true;
  }

  path(): string {
    return this.filePath;
  }
}

export interface RuntimeEventPipeline {
  record(chunk: string): void;
  close(): Promise<void>;
}

export async function startRuntimeEventPipeline(input: {
  dataDirectory: string;
  runId: string;
  onEvent: (event: Record<string, unknown>) => void | Promise<void>;
  onProblem?: ((problem: RuntimeEventStreamProblem) => void | Promise<void>) | undefined;
  isTerminalEvent: (event: Record<string, unknown>) => boolean;
  disrupted?: boolean | undefined;
}): Promise<RuntimeEventPipeline> {
  const writer = await RuntimeEventFile.create(input.dataDirectory, input.runId);
  const scraper = new RuntimeEventScraper({
    runId: input.runId,
    filePath: writer.path(),
    onEvent: input.onEvent,
    onProblem: input.onProblem,
    isTerminalEvent: input.isTerminalEvent,
    disrupted: input.disrupted ?? false,
  });
  await scraper.start();

  let closed = false;
  return {
    record(chunk: string) {
      void writer.append(chunk).catch((error) => {
        scraper.recordWriteFailure(error);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await writer.close();
      } catch (error) {
        scraper.recordWriteFailure(error);
      }
      await scraper.flush();
      await scraper.close();
    },
  };
}
