import path from "node:path";
import type { IntentDerivation, IntentState } from "../intent/intent-model.js";

// PLAN_AUDITOR's AgentChatAuditor: one auditor per (agentId, chatId). It owns
// the identity every finding for that chat is stamped with, the folder its
// artifacts are written to, and the per-chat state that used to live in
// parallel maps on the service — whether a meta-audit is running, and how
// many step audits are still in flight.
//
// Keying that state by chat *object* rather than by lookups on a trace id
// is the point: they are facts about one thing, and the run-level checks
// need them to agree. The forward trace must not read the run back until
// this chat's step audits have finished, and nothing outside this chat can tell
// it that.
//
// What it deliberately does not own is what only works process-wide: the
// BatchCaller, because a provider rate limit is shared across every chat, and
// the memo of models the account has not activated, because a model that does
// not exist for this chat does not exist for the next one either. Those stay on
// the service, and the chat auditor calls into it for them.
export interface PinnedIntent {
  derivation: IntentDerivation;
}

export interface ChatAuditorWork {
  runStepAudit(chat: AgentChatAuditor, spanId: string): Promise<void>;
  runAll(chat: AgentChatAuditor): Promise<void>;
  runRequestedAudit(chat: AgentChatAuditor): Promise<void>;
}

export class AgentChatAuditor {
  // agent-runs/{agentId}/{chatId}/, the folder this chat's step records and
  // meta index live in and the archive download serves.
  readonly memoryFolderPath: string;
  // The spec this chat is judged against, derived once at the start of the
  // audit pass. Identified rather than read from a standing store, so a later
  // run's derivation cannot rewrite what this one was judged against.
  private pinned: PinnedIntent | null = null;
  private identifying: Promise<PinnedIntent> | null = null;

  get derivation() {
    return this.pinned?.derivation ?? null;
  }

  get intentState(): IntentState | null {
    return this.pinned?.derivation.state ?? null;
  }

  async identifyIntent(
    identify: () => Promise<IntentDerivation>,
  ): Promise<PinnedIntent> {
    if (this.pinned) return this.pinned;
    if (!this.identifying) {
      this.identifying = identify().then((derivation) => {
        this.pinned = { derivation };
        return this.pinned;
      });
    }
    return this.identifying;
  }

  // Step audits queued or running for this chat. Counted at enqueue rather than
  // at start, or a step still sitting in the batch queue would not be waited
  // for by the run-level checks.
  private open = 0;
  private waiters: (() => void)[] = [];
  private requestRunning = false;
  // This auditor's own run, as a trace. Opened lazily on the first model call
  // it makes, not at construction: a chat whose audits were all answered
  // deterministically never asked a model anything, and should not leave an
  // empty trace behind claiming it did.
  private auditTrace: string | null = null;

  get auditTraceId() {
    return this.auditTrace;
  }

  openAuditTrace(open: () => string): string {
    if (this.auditTrace === null) this.auditTrace = open();
    return this.auditTrace;
  }

  // Ends the current pass and returns the trace it wrote, so the next one
  // starts a new trace rather than appending to a finished run. One trace per
  // pass: re-auditing is the auditor doing the work again, not the earlier run
  // growing new steps after it ended.
  closeAuditTrace(): string | null {
    const closing = this.auditTrace;
    this.auditTrace = null;
    return closing;
  }

  constructor(
    readonly agentId: string,
    readonly chatId: string,
    memoryRoot: string,
    private readonly work: ChatAuditorWork,
  ) {
    this.memoryFolderPath = path.join(memoryRoot, agentId, chatId);
  }

  openStep() {
    this.open += 1;
  }

  closeStep() {
    this.open -= 1;
    if (this.open > 0) return;
    this.open = 0;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  // Resolves once every step audit for this chat has finished. Safe to await
  // from inside a batch: the step audits being waited for are either running
  // alongside the waiter or queued behind it, and the BatchCaller flushes what
  // is queued as batches free up, so neither case can wait on the waiter.
  awaitSteps(): Promise<void> {
    if (this.open === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  auditStep(spanId: string) {
    return this.work.runStepAudit(this, spanId);
  }

  // Runs after the individual steps and after the chat itself has finished.
  auditAll() {
    return this.work.runAll(this);
  }

  // An audit someone asked for, as opposed to one the subscription raised.
  // One at a time: a second trigger while the first is running would judge a
  // half-written record.
  //
  // This is the only way a trace above depth 0 is ever judged. Auditing an
  // auditor, and auditing that auditor in turn, all arrive here — the depth is
  // whatever the caller has clicked through, and nothing reaches it on its own.
  async auditOnRequest(): Promise<"in-flight" | "done"> {
    if (this.requestRunning) return "in-flight";
    this.requestRunning = true;
    try {
      await this.work.runRequestedAudit(this);
      return "done";
    } finally {
      this.requestRunning = false;
    }
  }
}
