import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyIntent,
  intentIsEmpty,
  type IntentDerivation,
  type IntentState,
} from "../intent/intent-model.js";
import type { TraceRecord } from "../trace/trace-model.js";
import {
  chatAuditSchema,
  worstHealth,
  type AuditHealth,
  type AuditPass,
  type AuditTraceStep,
  type ChatAudit,
} from "./audit-model.js";

// How many superseded passes a trace keeps. The newest answer is the one that
// counts; the ones before it are there so a re-audit can be second-guessed and
// so an interrupted one leaves something behind, neither of which needs a long
// tail.
const MAX_AUDIT_HISTORY = 5;

function tokensFrom(trace: TraceRecord) {
  return {
    input: trace.usage.inputTokens,
    output: trace.usage.outputTokens,
    cached: trace.usage.cachedTokens,
    reasoning: trace.usage.reasoningTokens,
  };
}

function findingsOf(doc: ChatAudit) {
  return [...Object.values(doc.spanAudit).flat(), ...doc.runAudit].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

// One health note is enough. A 30-step run that fell back on every call
// would otherwise repeat the same "primary model is not available" line.
function mergeSteps(doc: ChatAudit, steps: AuditTraceStep[]) {
  const rest = steps.filter((step) => step.category !== "audit-health");
  const incoming = steps.filter((step) => step.category === "audit-health");
  if (incoming.length === 0) return rest;
  const have = findingsOf(doc).filter((step) => step.category === "audit-health");
  if (have.some((step) => step.type === "error")) return rest;
  if (have.length > 0) {
    return rest.concat(incoming.filter((step) => step.type === "error"));
  }
  return rest.concat(incoming);
}

// What the agent did, as opposed to what the auditor managed to do about it.
// Only these belong in a warning count.
function agentFindingsOf(doc: ChatAudit) {
  return findingsOf(doc).filter(
    (finding) => finding.category !== "audit-health",
  );
}

// A suspicion is a question the auditor could not settle, not a claim that the
// agent did something wrong. Counting it as a warning would make the summary
// row state exactly what the severity exists to avoid stating.
function countsOf(doc: ChatAudit) {
  let warnings = 0;
  let suspicions = 0;
  for (const finding of agentFindingsOf(doc)) {
    if (finding.type === "suspicion") suspicions += 1;
    else warnings += 1;
  }
  return { warnings, suspicions };
}

export class AuditStore {
  private readonly docs = new Map<string, ChatAudit>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    // Reports a write that did not land. Persistence is deliberately
    // fire-and-forget so a slow disk cannot stall a run, but swallowing the
    // error let the in-memory state and the file diverge in silence: after a
    // restart the data is simply gone, with nothing anywhere having said so.
    private readonly log?: (message: string, error?: unknown) => void,
  ) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const doc = chatAuditSchema.parse(
          JSON.parse(await readFile(path.join(this.directory, entry), "utf8")),
        );
        this.docs.set(entry.slice(0, -".json".length), doc);
      } catch {
        // Ignore unreadable audit files.
      }
    }
  }

  recordSpan(
    trace: TraceRecord,
    spanId: string,
    steps: AuditTraceStep[],
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    const existing = doc.spanAudit[spanId] ?? [];
    doc.spanAudit[spanId] = existing.concat(mergeSteps(doc, steps));
    doc.health = worstHealth(doc.health, health);
    this.persist(trace.id);
  }

  // Files the answers this trace currently holds as a superseded pass, and
  // starts the next one from empty.
  //
  // It clears, but nothing is destroyed: what it clears is kept. That is the
  // difference from emptying the document outright, which is what this
  // replaces — a re-audit interrupted partway then left the trace with no
  // findings and no way back to the ones it had, because nothing resumes a
  // requested audit.
  //
  // Starting empty matters beyond tidiness. mergeSteps decides what to keep by
  // looking at the whole document, so answers left over from the previous pass
  // suppress the ones replacing them: a second pass would record less than it
  // found.
  //
  // Oldest passes are dropped rather than kept forever: this file is read on
  // every trace request, and a trace re-audited fifty times is not fifty times
  // more informative.
  beginPass(trace: TraceRecord) {
    const doc = this.docs.get(trace.id);
    if (!doc) return;
    const hasAnswers =
      doc.runAudit.length > 0 || Object.keys(doc.spanAudit).length > 0;
    if (!hasAnswers) return;
    doc.history = [
      ...doc.history,
      {
        recordedAt: new Date().toISOString(),
        health: doc.health,
        spanAudit: structuredClone(doc.spanAudit),
        runAudit: structuredClone(doc.runAudit),
      },
    ].slice(-MAX_AUDIT_HISTORY);
    doc.spanAudit = {};
    doc.runAudit = [];
    this.persist(trace.id);
  }

  // Superseded passes over this trace, oldest first.
  passesFor(traceId: string): AuditPass[] {
    return structuredClone(this.docs.get(traceId)?.history ?? []);
  }

  // This span's answer, replacing whatever it said before rather than adding
  // to it. Asking an auditor the same question again produces the same shape
  // of answer, so appending would double every finding.
  //
  // Replacing one span at a time is what makes a re-audit survivable. The
  // alternative — emptying the whole document first and refilling it — leaves
  // nothing at all if the process dies partway, destroying verdicts that were
  // never going to be replaced. Here a crash leaves the spans already re-judged
  // holding new answers and the rest holding their previous ones.
  replaceSpan(
    trace: TraceRecord,
    spanId: string,
    steps: AuditTraceStep[],
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    // Dropped before merging so this span's own previous health note does not
    // suppress the one replacing it.
    delete doc.spanAudit[spanId];
    doc.spanAudit[spanId] = mergeSteps(doc, steps);
    doc.health = worstHealth(doc.health, health);
    this.persist(trace.id);
  }

  recordRun(
    trace: TraceRecord,
    steps: AuditTraceStep[],
    contextSummary: string,
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    doc.runAudit = doc.runAudit.concat(mergeSteps(doc, steps));
    doc.contextSummary = contextSummary;
    doc.health = worstHealth(doc.health, health);
    this.syncFromTrace(doc, trace);
    if (trace.status !== "running") {
      if (trace.endedAt) {
        doc.summary.endTime = Date.parse(trace.endedAt);
      } else {
        doc.summary.endTime = Date.parse(trace.startedAt);
      }
    }
    this.persist(trace.id);
  }

  // A run-level finding that must not close the run audit out. Intent
  // classification fails while the run is still in flight, and borrowing
  // recordRun here would stamp an endTime and make the trace look audited
  // before the real run-level audit has happened.
  recordRunFinding(
    trace: TraceRecord,
    steps: AuditTraceStep[],
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    doc.runAudit = doc.runAudit.concat(steps);
    doc.health = worstHealth(doc.health, health);
    this.persist(trace.id);
  }

  // Published findings for one pass. Replaces span and run answers together so
  // a retry cannot leave a mix of the previous pass and the one still running.
  // Called only after auditAll has finished, which is when the record is
  // something a reader can trust.
  commitPass(
    trace: TraceRecord,
    input: {
      spanAudit: Record<string, AuditTraceStep[]>;
      runAudit: AuditTraceStep[];
      health: AuditHealth;
      contextSummary: string;
    },
  ) {
    const doc = this.ensure(trace, "");
    doc.spanAudit = Object.fromEntries(
      Object.entries(input.spanAudit).map(([spanId, steps]) => [
        spanId,
        [...steps],
      ]),
    );
    doc.runAudit = [...input.runAudit];
    doc.health = input.health;
    doc.contextSummary = input.contextSummary;
    this.syncFromTrace(doc, trace);
    if (trace.status !== "running") {
      doc.summary.endTime = Date.parse(trace.endedAt ?? trace.startedAt);
    }
    this.persist(trace.id);
  }

  // Drops the previous per-step answers, for the same reason clearRunAudit
  // drops the run-level one. Only the requested path writes step findings it
  // will write again; the automatic pass writes each step once, and clearing
  // those would throw away work nothing is going to redo.
  clearSpanAudits(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return;
    doc.spanAudit = {};
    this.persist(traceId);
  }

  // Drops the previous run-level answer, so re-running the pass that writes it
  // replaces rather than stacks. Step findings are left alone: they are keyed
  // by span and re-auditing does not revisit them.
  clearRunAudit(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return;
    doc.runAudit = [];
    this.persist(traceId);
  }

  // Replaces the run audit rather than appending to it. The automatic pass
  // happens once per run and so concatenates; an audit someone asked for can be
  // asked for again, and answering the same question twice must give one answer
  // rather than two stacked.
  recordRequestedAudit(
    trace: TraceRecord,
    steps: AuditTraceStep[],
    intentId: string,
    health: AuditHealth = "ok",
  ) {
    const doc = this.ensure(trace, intentId);
    doc.runAudit = [...steps];
    // Reset rather than merged: the previous answer is gone, so keeping the
    // health it reported would outlive the findings that explained it.
    doc.health = health;
    this.syncFromTrace(doc, trace);
    if (trace.status !== "running") {
      doc.summary.endTime = Date.parse(trace.endedAt ?? trace.startedAt);
    }
    this.persist(trace.id);
  }

  // Read-only from here on. An auditor's steps are spans on its own trace now,
  // and an audit of an auditor is an ordinary audit of that trace — so nothing
  // writes either of these fields any more. They are still read because
  // documents written by the earlier version have them, and a finding already
  // recorded should not disappear because the shape around it changed.
  metaAudit(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return { findings: [], auditedAt: null };
    return { findings: [...doc.metaAudit], auditedAt: doc.metaAuditedAt };
  }

  listAuditorSpans(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    return [...doc.auditorSpans];
  }

  listByTrace(traceId: string) {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    return findingsOf(doc);
  }

  isRunComplete(traceId: string) {
    return (this.docs.get(traceId)?.summary.endTime ?? 0) > 0;
  }

  // Every spec version this trace's findings were judged against, in the order
  // they were first used. Derived from the findings rather than read off the
  // document, whose own field is last-writer-wins and so reports the version
  // that happened to be current when the final finding landed — wrong for
  // exactly the runs that matter, the ones that span a spec change.
  intentIds(traceId: string): string[] {
    const doc = this.docs.get(traceId);
    if (!doc) return [];
    const seen = findingsOf(doc)
      .map((finding) => finding.intentId)
      .filter((id) => id.length > 0);
    const ordered = [...new Set(seen)];
    // Audits written before findings carried a version still have the document
    // field, and it is the only answer available for them.
    if (ordered.length === 0 && doc.intentId.length > 0) return [doc.intentId];
    return ordered;
  }

  // The version the run began under: the one a reader means by "the spec this
  // trace was judged against" when there is only room to name one.
  intentId(traceId: string) {
    return this.intentIds(traceId)[0] ?? null;
  }

  // The spec this audit judged against. Null when the identifier phase has
  // not run for this trace (or ran against an empty spec).
  intentOf(traceId: string): IntentState | null {
    const doc = this.docs.get(traceId);
    if (!doc || intentIsEmpty(doc.intent)) return null;
    return {
      instructions: doc.intent.instructions,
      objective: doc.intent.objective,
      extended: [...doc.intent.extended],
    };
  }

  derivationOf(traceId: string): IntentDerivation | null {
    const doc = this.docs.get(traceId);
    return doc?.intentDerivation ?? null;
  }

  // Identifier phase: write the derived spec once. Later findings inherit it
  // rather than re-reading a standing store.
  recordIntent(trace: TraceRecord, derivation: IntentDerivation) {
    const doc = this.ensure(trace, "");
    if (!intentIsEmpty(doc.intent)) return;
    doc.intent = {
      instructions: derivation.state.instructions,
      objective: derivation.state.objective,
      extended: [...derivation.state.extended],
    };
    doc.intentDerivation = derivation;
    this.persist(trace.id);
  }

  countStepsForTrace(traceId: string) {
    return Object.keys(this.docs.get(traceId)?.spanAudit ?? {}).length;
  }

  // Findings about the agent only, split by whether the auditor actually
  // concluded something. An auditor outage inflates neither.
  countsByTrace() {
    const counts = new Map<string, { warnings: number; suspicions: number }>();
    for (const [chatId, doc] of this.docs) {
      counts.set(chatId, countsOf(doc));
    }
    return counts;
  }

  health(traceId: string): AuditHealth {
    return this.docs.get(traceId)?.health ?? "ok";
  }

  healthByTrace() {
    const health = new Map<string, AuditHealth>();
    for (const [chatId, doc] of this.docs) health.set(chatId, doc.health);
    return health;
  }

  async flush() {
    await this.queue;
  }

  private ensure(trace: TraceRecord, intentId: string) {
    let doc = this.docs.get(trace.id);
    if (!doc) {
      doc = {
        agentId: trace.agentId,
        intentId,
        health: "ok",
        intent: emptyIntent(),
        contextSummary: "",
        summary: {
          tokenSummary: tokensFrom(trace),
          startTime: Date.parse(trace.startedAt),
          endTime: 0,
          model: trace.model ?? "",
        },
        spanAudit: {},
        runAudit: [],
        auditorSpans: [],
        metaAudit: [],
        metaAuditedAt: null,
        history: [],
      };
      this.docs.set(trace.id, doc);
      return doc;
    }
    // The first audit pins the specification for this trace. Later step
    // records may finish after the Agent's active intent changes, but they
    // must not relabel historical evidence with that newer version (including
    // replacing an intentionally empty id for a trace with no standing spec).
    this.syncFromTrace(doc, trace);
    return doc;
  }

  private syncFromTrace(doc: ChatAudit, trace: TraceRecord) {
    doc.summary.tokenSummary = tokensFrom(trace);
    doc.summary.model = trace.model ?? "";
    doc.summary.startTime = Date.parse(trace.startedAt);
  }

  private persist(chatId: string) {
    const doc = this.docs.get(chatId);
    if (!doc) return;
    const filePath = path.join(this.directory, chatId + ".json");
    const snapshot = JSON.stringify(doc, null, 1);
    this.queue = this.queue
      .then(async () => {
        await writeFile(filePath + ".tmp", snapshot + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(filePath + ".tmp", filePath);
      })
      .catch((error) =>
        this.log?.("failed to persist audit for trace " + chatId, error),
      );
  }
}
