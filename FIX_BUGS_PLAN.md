# Recursive auditing — driving defects

## Context

Recursive auditing is implemented and green (399 server, 71 web tests): auditor runs are
first-class traces carrying `auditOf` / `auditDepth`, the automatic pass is gated to depth 0
by `isAuditorTrace`, a requested audit judges each auditor step individually, and the
breadcrumb walks the chain back to the agent run.

Driving it surfaced four defects. Two share a root cause, and a third is what makes a
fourth visible.

**1 & 4 — the audit button targets the wrong trace.** `TraceAuditor.tsx:315` audits
`auditTraceId`, the auditor *of* the current trace, not the current trace:

```ts
mutationFn: () => api.audit(auditTraceId),
onSuccess: () => { ...invalidate(auditTraceId); navigate("/traces/" + auditTraceId); }
```

So a trace reached by "Open this auditor's trace →" has no auditor yet, `auditTraceId` is
null, and the button is disabled — that level is a dead end, which is exactly the reported
symptom. `onSuccess` also invalidates only the *destination's* query keys, never the
current page's, so revisiting a page can hand back a stale `auditTraceId` and navigate
somewhere unexpected — which reads as breadcrumb navigation breaking at depth.

**3 — the 60s model timeout.** `buildMetaContext` (`run-checks.ts:215`) is the only
unbounded prompt in the codebase: it iterates every span with no cap, at
`META_EVIDENCE_CLIP` (1500) + `META_VERDICT_CLIP` (800) each. The forward and back traces
already slice theirs to `MAX_TRACED_STEPS = 40`. With the requested-audit budget at 150
steps, the run-level meta prompt reaches ~350KB, and `createArkClient(config)`
(`index.ts:33`) takes the hardcoded 60s default.

**2 — the auditor health bar reads as a run-on.** `healthCopy` (`TraceAuditor.tsx:136`)
correctly dedupes identical notes into `"<message> (on N audited steps)"`, then
`.join(" ")` collapses distinct notes into a single paragraph rendered as one `<p>`. A
model timeout produces a note per failing step, so defect 3 is what makes this visible.

> The screenshot referenced in the report did not come through. This plan is written from
> the description plus what `healthCopy` does; if the bar shows something else, say so.

## Decisions taken

| Decision | Choice |
|---|---|
| Audit button target | The **current** trace, staying on the page |
| Timeout | Cap the run-level meta prompt rather than waiting longer |

---

## Implementation

### 1. Audit the trace you are looking at — `apps/web/src/traces/TraceAuditor.tsx`

The mutation targets `trace.id`, invalidates the **current** page's keys, and does not
navigate:

```ts
mutationFn: () => api.audit(trace.id),
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ["audit", trace.id] });
  void queryClient.invalidateQueries({ queryKey: ["trace", trace.id] });
},
```

`useNavigate` is then unused here and goes. Going deeper becomes: open the auditor's trace,
audit it, repeat — one level per click, never disabled, and the breadcrumb never shifts
under you.

**Show the button only when the current trace is itself an auditor run**
(`trace.auditOf !== null`). At depth 0 the automatic pass owns the audit, and re-auditing an
agent run would mint a *new* auditor trace — `indexAudit` (`trace-store.ts:91`) keeps the
newest, so `auditorTraceFor(A)` would re-point and the whole stack below the old one would
stop being reachable from the agent run. The endpoint still accepts depth 0 (already
idempotent via `clearRunAudit`, with a test); it just is not a button. Flagging this
because it is one affordance less on the agent-run page than today — push back if you want
it kept.

The agent-run page keeps "Open this auditor's trace →", which is how you reach depth 1.

### 2. The health bar as a list — `TraceAuditor.tsx` + `styles.css`

`healthCopy` returns `{ title, body, notes: string[] }` instead of folding notes into
`body`. The dedupe-with-count logic is unchanged; only the join goes. `body` stays as the
standing sentence used when nothing was recorded. Render `notes` as a `<ul>` under the
title, falling back to `<p>{body}</p>` when the list is empty.

### 3. Bound the run-level meta prompt — `middlewares/audit/run-checks.ts`

Add `META_MAX_STEPS = 40` beside the existing clips and slice `buildMetaContext` to the
most recent that many, saying so in the heading — `"## Auditor steps (40 of 150, most
recent shown)"` — so a truncated prompt never reads as the whole record. This mirrors what
`forwardTrace` and `backTrace` already do with `MAX_TRACED_STEPS`.

The per-step calls need no cap: `buildAuditorStepContext` covers one span each and is
already bounded.

### 4. Deep-chain coverage — `trace-store.test.ts`, `audit-service.test.ts`

The existing recursion test stops at depth 4 (`audit-service.test.ts:1234`). Extend it so
each level's `auditChain` length equals `auditDepth + 1` through depth 5 — that is the
assertion that would catch a genuine structural break in the chain, as opposed to the
navigation bug above.

Defect 4 was reported as breadcrumb navigation breaking past the third level. The stale
`auditTraceId` above is the most likely cause and the fix removes navigation from the audit
action entirely, so it should not recur — but it needs re-checking against the running app,
since the chain walk itself is a pure upward walk that reads correct at any depth.

---

## Verification

**Automated** — `npm run check`.

- `auditor-health.test.ts` — `healthCopy` returns distinct notes as separate entries rather
  than one joined string; the count collapsing for repeated notes still holds; the standing
  copy still appears when nothing was recorded.
- `run-checks` coverage for `buildMetaContext` — a trace with more than `META_MAX_STEPS`
  spans yields a bounded prompt that names how many were omitted.
- `audit-service.test.ts` — the deep-chain assertion above, and the existing recursion
  guard (an auditor span must never enqueue an audit of itself) must keep passing.

**End to end** — run an agent, open its trace:
1. Agent-run page → "Open this auditor's trace →" → on the auditor's page the audit button
   is **enabled**, not dead.
2. Click it: the page stays put and its auditor pane fills with the new auditor's steps and
   findings about this trace. "Open this auditor's trace →" then appears.
3. Repeat four or five levels down. The breadcrumb grows one entry per level and every
   entry navigates correctly, both up and back down.
4. Auditing an auditor of a long run completes without a 60s model timeout.
5. Force a model failure (bad `AUDIT_SECURITY_MODEL`) and confirm the health bar lists the
   distinct problems as separate lines rather than one concatenated sentence.

## Note on the working tree

Another process wrote to this repo during earlier sessions — `AuditorStepList.tsx`,
`auditor-groups.*` and a transient `__verify.test.tsx` appeared and were reverted, and
`TraceAuditor.tsx` was rewritten more than once. Worth confirming nothing else is running
before starting.
