import type { AuditMemory } from "./audit/audit-memory.js";
import type { AuditService } from "./audit/audit-service.js";
import type { AuditStore } from "./audit/audit-store.js";
import type { ContextService } from "./context/context-service.js";
import type { IntentCorrectionStore } from "./intent/correction-store.js";
import type { TraceService } from "./trace/trace-service.js";
import type { TraceStore } from "./trace/trace-store.js";

// The routes each middleware registers read across the others — a trace
// payload carries its findings, its intent and its run context — so the deps
// bag is shared rather than per-middleware. It lives here, apart from
// middlewares/index.ts, so a routes file can name the type without importing
// the barrel that imports it back.
export interface MiddlewareDeps {
  traceStore: TraceStore;
  auditStore: AuditStore;
  traceService: TraceService;
  contextService?: ContextService;
  // Needed for the manual meta-audit and the artifact archive. Optional so a
  // deployment without auditing still serves traces.
  auditService?: AuditService;
  auditMemory?: AuditMemory;
  // Where an operator's corrections to an Agent's spec are recorded. Optional
  // so a deployment that only reads traces still serves them; without it the
  // correction routes report that correcting is unavailable rather than
  // applying an edit nothing would remember.
  correctionStore?: IntentCorrectionStore;
}
