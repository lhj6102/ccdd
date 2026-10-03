import { streamProjectResults, projectRequestSummary, projectRunSummary } from '../project/results.js';
import { beginAttempt, recordAttemptTool, readAttemptSummary, finishAttempt } from './attempt-summary.js';
import { prepareProject, preparedProjectData, type PreparedProject, type PrepareProjectOptions } from '../project/prepared.js';
import { selectProfiles, type ProfileSelection } from '../project/profiles.js';
import { openIdentityCache, identityCacheDirectory, type IdentityCache, type CachedReview } from '../cache/index.js';
import { snapshotCache, snapshotActive, cacheSource } from '../project/cache-evidence.js';
import { executionRecord } from './cache-execution.js';
import { projectRequestState } from '../project/store.js';
import { diagnosticScope } from '../diagnostic-scope.js';
import { captureExecution } from '../provenance.js';
import { executionScope } from '../execution-scope.js';
import { openResources, canonicalRepositoryId, rejectIdentityConcurrency, validateMaxExecutions, type ResourceLease } from '../resources.js';
import { assertStateFormat, initializeStateFormat } from '../state-format.js';
import { semanticResult, validateFinalResult } from '../response-schema.js';
import { requesterRun, requesterRequest, resultView, type ResultDetail, type ResultOptions } from '../result-view.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay, setImmediate as yieldTurn } from 'node:timers/promises';
import { prepareReviewRequests } from '../requester/index.js';
import { readWorkspaceConfig } from './config.js';
import { createGraphDefinition, type GraphDefinition } from './graph.js';
import { type Admission, type AdmissionLease } from './admission.js';
export type { Admission, AdmissionLease, AdmissionRequest } from './admission.js';
import { readChanges, type ChangeOptions } from './changes.js';
import { initializeRecords, records, RECORDED_ARGUMENT_BYTES, RECORDED_TOOL_CALLS } from './storage.js';
import { createReadiness } from './readiness.js';
import { createStatusPolling } from './polling.js';
import { ownerAlive, ownProcessIdentity, type OwnerRecord } from './ownership.js';
import { coalescingEligibility, findCoalescibleRequest } from './coalescing.js';
import { tokenUsage, toolResponseBytes } from '../executors/telemetry.js';
import { finalResultEventData } from '../executors/final-result.js';
import { normalizeReviewResult as validateResult, storedObservation } from '../review-result.js';
import { createReviewTools, type ToolExecutionDiagnostic } from '../tools/runner.js';
import { createHumanClaims, HUMAN_PREPARATION_LEASE_MS } from './human-claims.js';
import { prepareHumanReview } from '../executors/human-preparation.js';
import { prepareWorkspace, reopenWorkspace, type WorkspaceDescriptor, type WorkspaceHandle, type WorkspaceIntegrity } from '../workspaces/index.js';
import { createProjectSnapshot, positiveConcurrency } from '../project/identity.js';
import { includedCritics, planProject } from '../project/query.js';
import { readEvidence, storedRequesterRun } from '../project/store.js';
import type { ProjectRunDefinition, ProjectSelection } from '../project/types.js';
import type { RunStatus, ExecutionSource } from '../contracts.js';
import type { ReviewEnvelope, ReviewRequest, ReviewResult, ReviewStatus, ReviewToolCall, ExecutionContext, ExecutorReadiness, ExecutionEvent } from '../contracts.js';

/** Internal instrumentation for deterministic scheduler regression tests. */
export const brokerTestHooks: { onHydrate?: (bytes: number) => void; onPlan?: () => void; onIdleTick?: () => void; onSubmissionCommit?: (durationMs: number) => void } = {};
const preparedInput = Symbol('prepared-project');
const executionMode = Symbol('cache-owned-execution');
const enqueueExecution = Symbol('enqueue-prepared-execution');
interface ExecutionBroker {
  [enqueueExecution](request: ReviewRequest, workspace: WorkspaceDescriptor, id: string, budgetRunId: string): Promise<void>;
  run(id: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  getRequest(id: string): ReviewRequest | null;
  tryClaimHuman: (...args: any[]) => any; renewHumanTryClaim: (...args: any[]) => any; releaseHumanTryClaim: (...args: any[]) => any;
  claimHuman: (...args: any[]) => Promise<unknown>; executeHumanTool: (...args: any[]) => Promise<any>; completeHuman: (...args: any[]) => Promise<unknown>;
  close(): Promise<void>;
}
export interface RunRecord {
  executionOwned?: boolean; budgetRunId?: string;
  id: string; repoId: string; snapshotHash: string; workspace: WorkspaceDescriptor;
  requesterId: string; scope?: { kind: 'graph' } | { kind: 'chain' } | { kind: 'critic'; criticId: string } | { kind: 'project' };
  project?: ProjectRunDefinition;
  graph?: GraphDefinition;
  workerProtocol?: 'resources-1'; maxExecutions?: number; repoExecutorCap?: number; status: RunStatus; coalescingGraceMs?: number; createdAt: string; completedAt?: string; error?: string;
}
export interface BrokerEvent { id: number; runId: string; requestId: string | null; createdAt: string; type: string; message: string; data?: unknown }
export interface RunView extends RunRecord { scope: NonNullable<RunRecord['scope']>; owner: { pid: number; claimedAt: string } | null; requests: ReviewRequest[]; events: BrokerEvent[] }
export interface BrokerExecutors {
  validateWorkspace?(repoPath: string): void | Promise<void>;
  canExecute(request: ReviewRequest): ExecutorReadiness | Promise<ExecutorReadiness>;
  execute(request: ReviewRequest, context: ExecutionContext & { signal: AbortSignal }): Promise<unknown>;
  notifyHuman?(request: ReviewRequest, context: { signal: AbortSignal }): Promise<unknown>;
}
export interface BrokerOptions { [executionMode]?: boolean; repoPath: string; stateDir: string; repoId?: string; coalescingGraceMs?: number; maxConcurrentExecutors?: number; admission?: Admission; identityConcurrency?: number; executors?: BrokerExecutors; workspaceIntegrity?: WorkspaceIntegrity; workspaceAdapter?: { prepareWorkspace: typeof prepareWorkspace; reopenWorkspace: typeof reopenWorkspace } }
interface ActiveRun { runId: string; token: string; abort: AbortController; promise: Promise<RunRecord & { requests: ReviewRequest[] }> | null }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorCode = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined;
const parseStored = <T>(value: unknown): T => { if (typeof value !== 'string') throw new Error('Broker store contains a non-text JSON record.'); brokerTestHooks.onHydrate?.(Buffer.byteLength(value)); return JSON.parse(value) as T; };
const required = <T>(value: T | null | undefined, label: string): T => { if (value == null) throw new Error(`Unknown ${label}.`); return value; };


const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const now = () => new Date().toISOString();
const errorText = (error: unknown) => String(object(error) && typeof error.message === 'string' ? error.message : error).slice(0, 2000);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const codedError = (message: string, code: string) => Object.assign(new Error(message), { code });
const fatalExecutionError = (error: unknown): boolean => {
  const code = errorCode(error);
  return Boolean(code?.startsWith('WORKSPACE_') || ['RUN_OWNERSHIP_LOST', 'REVIEW_CANCELED', 'WORKER_STOPPED', 'WORKER_EXITED', 'REVIEW_GRAPH_INVALID'].includes(code ?? ''));
};


function canonicalFuturePath(value: string) {
  let existing = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

/** Read an existing store's repository identity without creating state or needing its source. */
export function readStateContext(stateDir: string) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('An existing stateDir is required.');
  const canonical = fs.realpathSync(stateDir);
  const filename = path.join(canonical, 'broker.sqlite');
  if (!fs.statSync(filename).isFile()) throw new Error('State directory does not contain a broker store.');
  // A worker closing the last WAL connection can briefly lock even read-only queries.
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    assertStateFormat(database);
    const row = database.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = row ? parseStored<unknown>(row.value) : null;
    if (!object(identity) || typeof identity.repoPath !== 'string' || !path.isAbsolute(identity.repoPath) || typeof identity.repoId !== 'string') throw new Error('State directory has no valid repository identity.');
    return { repoPath: identity.repoPath, repoId: identity.repoId, stateDir: canonical };
  } finally { database.close(); }
}

function prepareStateDirectory(repoPath: string, stateDir: string) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('An external stateDir is required.');
  const canonical = canonicalFuturePath(stateDir);
  const relative = path.relative(repoPath, canonical);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw codedError('CCDD state, logs and review outputs must be outside the reviewed repository.', 'WORKSPACE_UNSAFE');
  }
  fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  return fs.realpathSync(canonical);
}

/** Durable broker operations. Merely opening the store never starts a worker. */
export function createBroker<D extends ResultDetail = 'compact'>({ [executionMode]: rawExecution = false, detail, repoPath, stateDir, repoId = 'demo', coalescingGraceMs = 15_000, maxConcurrentExecutors, admission, identityConcurrency, executors, workspaceIntegrity = 'content', workspaceAdapter = { prepareWorkspace, reopenWorkspace } }: BrokerOptions & ResultOptions<D>) {
  if (maxConcurrentExecutors !== undefined) positiveConcurrency(maxConcurrentExecutors, 'maxConcurrentExecutors');
  rejectIdentityConcurrency(identityConcurrency);
  if (!Number.isSafeInteger(coalescingGraceMs) || coalescingGraceMs < 0 || coalescingGraceMs > 300_000) throw new Error('coalescingGraceMs must be an integer from 0 to 300000.');
  if (detail !== undefined && detail !== 'compact' && detail !== 'full') throw new Error('detail must be compact or full.');
  if (!['content', 'metadata'].includes(workspaceIntegrity)) throw new Error('Workspace integrity must be content or metadata.');
  try {
    repoPath = fs.realpathSync(repoPath);
    if (!fs.statSync(repoPath).isDirectory()) throw new Error('Workspace must be a directory.');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const identity = readStateContext(stateDir);
    if (canonicalFuturePath(repoPath) !== identity.repoPath) throw new Error('This state directory belongs to a different registered repository.');
    repoPath = identity.repoPath;
  }
  stateDir = prepareStateDirectory(repoPath, stateDir);
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  let db!: DatabaseSync;
  try {
    db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    initializeStateFormat(db);
    db.exec('COMMIT');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_run ON requests(run_id, ordinal);
      CREATE INDEX IF NOT EXISTS requests_validation_input ON requests(json_extract(data, '$.criticId'),json_extract(data, '$.inputKey'));
      CREATE INDEX IF NOT EXISTS requests_ready ON requests(run_id,status,ordinal);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), request_id TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_owners (run_id TEXT PRIMARY KEY REFERENCES runs(id), pid INTEGER NOT NULL, process_identity TEXT, token TEXT NOT NULL, claimed_at TEXT NOT NULL);`);
    initializeRecords(db);
    for (const row of db.prepare("SELECT o.*,r.data FROM run_owners o JOIN runs r ON r.id=o.run_id WHERE json_extract(r.data,'$.workerProtocol') IS NOT 'resources-1'").all()) {
      if (ownerAlive(row as unknown as OwnerRecord)) throw new Error('An old worker is still active in this state. Stop all 6.0 workers before using machine resource admission.');
    }
    const diagnostic = db.prepare("SELECT value FROM metadata WHERE key='diagnostic-only'").get();
    if (diagnostic && !diagnosticScope.getStore()) throw new Error('Offline diagnostic state cannot be opened as review evidence.');
    if (diagnosticScope.getStore()) db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('diagnostic-only','true')").run();
    const previousRepo = db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = JSON.stringify({ repoPath, repoId });
    if (previousRepo && previousRepo.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
    db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('registered-repo', identity);
    // Recheck after INSERT OR IGNORE, since another process may initialize concurrently.
    if (db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo')?.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
  } catch (error) { db?.close(); throw error; }

  let cache: IdentityCache | undefined;
  const peers = new Map<string, ExecutionBroker>();
  const sharedCache = () => cache ??= openIdentityCache({ directory: prepareStateDirectory(repoPath, identityCacheDirectory()) });
  const resources = openResources();
  const repositoryKey = canonicalRepositoryId(repoPath);
  const localCap = maxConcurrentExecutors ?? Number.MAX_SAFE_INTEGER;
  const polling = createStatusPolling(db);
  let closed = false;
  let closing = false;
  const active = new Map<string, ActiveRun>();
  const listeners = new Set<() => void>();
  const ensureOpen = () => { if (closed || closing) throw new Error('Broker is closed.'); };
  const requireExecutors = () => {
    if (!executors || typeof executors.canExecute !== 'function' || typeof executors.execute !== 'function') throw new Error('Review submission and execution require an executor registry.');
    return executors;
  };
  const store = records(db);
  const clearReadCaches = () => store.clear();
  const transaction = <T>(callback: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = callback(); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } finally { store.clear(); } throw error; }
  };
  const requestData = (id: string): ReviewRequest | null => store.request(id);
  const runData = (id: string): RunRecord | null => store.run(id);
  const ownerData = (id: string): OwnerRecord | undefined => db.prepare('SELECT * FROM run_owners WHERE run_id = ?').get(id) as OwnerRecord | undefined;
  const runRequests = (id: string): ReviewRequest[] => db.prepare('SELECT id FROM requests WHERE run_id=? ORDER BY ordinal').all(id).map(row => required(requestData(String(row.id)), 'Request'));
  const sharedRequests = (run: { id: string }): ReviewRequest[] => db.prepare("SELECT q.data FROM shared_members m JOIN requests q ON q.id=m.request_id WHERE m.run_id=? AND m.source_run_id!=?").all(run.id, run.id).map(row => parseStored<ReviewRequest>(row.data));
  const submissionDeadlines = new Map<string, number>();
  function sweepSubmissionDeadlines() {
    for (const id of submissionDeadlines.keys()) {
      const status = polling.runStatus(id);
      // Retain expired unowned sources: dropping their monotonic tombstone could
      // renew eligibility after a wall-clock rollback. Owned Runs cannot revert
      // to an abandoned submission; worker exit is reconciled as terminal.
      if (!status || terminal.has(status) || ownerData(id)) submissionDeadlines.delete(id);
    }
  }
  const coalescing = { reconcile: reconcileWithin, deadlines: submissionDeadlines };
  const requestHeader = (id: string): Record<string, any> | null => { const row = db.prepare('SELECT data FROM requests WHERE id=?').get(id); return row ? parseStored<Record<string, any>>(row.data) : null; };
  const saveHeader = (packed: Record<string, any>) => {
    db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run(packed.status, JSON.stringify(packed), packed.id);
    readiness.transition(packed);
  };
  const saveRequest = (request: ReviewRequest) => {
    const packed = required(requestHeader(request.id), 'Request');
    for (const key of ['status','startedAt','completedAt','claimedBy','claimedAt','tryClaim','preparationAttempt','claimAttemptId','notifiedAt','error','errorCode','blockedReason','executionProvenance'] as const) {
      if (request[key] === undefined) delete packed[key]; else packed[key] = request[key];
    }
    packed.resultRef = request.result ? store.put(request.result) : null;
    packed.semanticRef = request.result ? store.put(semanticResult(request.result)) : null;
    saveHeader(packed);
  };
  const appendEvent = (runId: string, requestId: string | null, type: string, message: string, data: unknown = null) => {
    db.prepare('INSERT INTO events(run_id,request_id,created_at,type,message,data) VALUES (?,?,?,?,?,?)').run(runId, requestId, now(), type, message.slice(0, 4000), data === null ? null : JSON.stringify(data));
  };
  const changed = () => { for (const callback of listeners) { try { callback(); } catch {} } };
  /**
   * Usage of one attempt, keyed like its tool-call record by the lease token that becomes the request's
   * attemptId, independent of the latest-500 event window. Callers write it in the same transaction as
   * its executor.usage event, so the sum always equals the stored events.
   */
  const addUsage = (requestId: string, attemptId: string, usage: Record<string, number>) => {
    const row = db.prepare('SELECT data FROM request_usage WHERE request_id=? AND attempt_id=?').get(requestId, attemptId);
    const total = row ? JSON.parse(String(row.data)) as Record<string, number> : {};
    for (const [key, count] of Object.entries(usage)) total[key] = (total[key] ?? 0) + count;
    db.prepare('INSERT INTO request_usage(request_id,attempt_id,data) VALUES (?,?,?) ON CONFLICT(request_id,attempt_id) DO UPDATE SET data=excluded.data').run(requestId, attemptId, JSON.stringify(total));
  };
  const humanClaims = createHumanClaims({ transaction, read: requestData, save: saveRequest, changed,
    event: (request, type, message) => appendEvent(request.runId, request.id, type, message),
    assertWaiting: request => {
      ensureOpen();
      if (request.configManifest?.version !== 2) throw new Error('Invalid stored review configuration.');
      if (!request.notifiedAt) throw new Error('Human alarm delivery is still pending.');
      if (!ownerAlive(ownerData(request.runId))) throw new Error('An in-place review requires its monitoring worker to remain alive.');
    },
  });
  const readiness = createReadiness(db, store, coalescing, appendEvent);
  const refreshReadinessWithin = (id: string) => readiness.refresh(id);
  const updateRunStatus = (id: string) => readiness.updateRun(id);

  function finishWithin(requestId: string, outcome: { result?: ReviewResult; error?: unknown; executionProvenance?: ReviewRequest['executionProvenance'] }, expectedStates: ReviewStatus[] = ['RUNNING', 'WAITING_HUMAN']) {
    const { result, error } = outcome, hasError = Object.hasOwn(outcome, 'error');
    const request = requestHeader(requestId);
    if (!request || !expectedStates.includes(request.status) || terminal.has(required(polling.runStatus(request.runId), 'Run'))) return false;
    if (hasError) captureSourceState(request);
    if (outcome.executionProvenance !== undefined) request.executionProvenance = outcome.executionProvenance;
    request.status = hasError ? 'ERROR' : required(result, 'review result').verdict;
    request.resultRef = result ? store.put(result) : null;
    request.semanticRef = result ? store.put(semanticResult(result)) : null;
    request.error = hasError ? errorText(error) : null;
    request.errorCode = errorCode(error) ?? null;
    request.completedAt = now();
    finishAttempt(db,requestId,request.attemptId,request.completedAt);
    saveHeader(request);
    // A result carries its own toolCalls; the attempt record would only duplicate them unseen.
    if (!hasError) db.prepare('DELETE FROM tool_call_records WHERE request_id=?').run(request.id);
    appendEvent(request.runId, request.id, hasError ? 'request.error' : 'request.completed', hasError ? required(request.error, 'error message') : `Review ${required(result, 'review result').verdict}.`, { status: request.status, ...(request.errorCode ? { code: request.errorCode } : {}) });

    return true;
  }

  function failWithin(runId: string, error: unknown) {
    const run = readiness.header(runId); if (!run || terminal.has(run.status)) return;
    // Cancellation is proportional to affected requests, never definitions.
    submissionDeadlines.delete(runId);
    run.status = 'ERROR'; run.error = errorText(error); run.completedAt = now();
    db.prepare('UPDATE runs SET status=?,data=? WHERE id=?').run(run.status, JSON.stringify(run), runId);
    for (const row of db.prepare("SELECT data FROM requests WHERE run_id=? AND status IN ('QUEUED','RUNNING','WAITING_HUMAN','WAIT_DEPENDENCY','BLOCKED')").all(runId)) {
      const request = parseStored<Record<string, any>>(row.data);
      captureSourceState(request);
      request.status = 'ERROR'; request.resultRef = null; request.semanticRef = null; request.error = errorText(error); request.errorCode = errorCode(error) ?? null; request.completedAt = now(); request.blockedReason = null;
      finishAttempt(db,request.id,request.attemptId,request.completedAt);
      db.prepare('UPDATE requests SET status=?,data=? WHERE id=?').run('ERROR', JSON.stringify(request), request.id);
      readiness.transition(request);
      appendEvent(runId, request.id, 'request.error', request.error, { status: request.status, ...(request.errorCode ? { code: request.errorCode } : {}) });
    }
    appendEvent(runId, null, 'run.error', run.error);
  }

  function reconcileWithin(runId: string) {
    const owner = ownerData(runId);
    if (!owner || ownerAlive(owner)) return;
    failWithin(runId, codedError('The review worker exited before completing its work. Submit a new run to retry.', 'WORKER_EXITED'));
    db.prepare('DELETE FROM run_owners WHERE run_id = ? AND token = ?').run(runId, owner.token);
    appendEvent(runId, null, 'worker.exited', 'The previous review worker is no longer running.');
  }

  function reconcile(runId?: string) {
    ensureOpen();
    transaction(() => {
      if (runId === undefined) for (const row of db.prepare('SELECT run_id FROM run_owners').all()) reconcileWithin(String(row.run_id));
      else reconcileWithin(runId);
    });
  }

  function getRun(id: string): RunView | null {
    ensureOpen();
    if (!polling.runStatus(id)) return null;
    if (ownerData(id)) reconcile(id);
    const run = required(runData(id), 'Run');
    const owner = ownerData(id);
    if (owner || terminal.has(run.status)) submissionDeadlines.delete(id);
    const events = db.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: Number(event.id), runId: String(event.run_id), requestId: event.request_id === null ? null : String(event.request_id), createdAt: String(event.created_at), type: String(event.type), message: String(event.message), ...(event.data ? { data: parseStored<unknown>(event.data) } : {}) }));
    const view = copy(run);
    return { ...view, scope: view.scope ?? { kind: view.graph ? 'graph' : 'chain' }, owner: owner ? { pid: owner.pid, claimedAt: owner.claimed_at } : null, requests: runRequests(id), events };
  }

  function failOwned(runId: string, token: string, error: unknown) {
    transaction(() => { if (ownerData(runId)?.token === token) failWithin(runId, error); });
    changed();
  }

  function copyExecutionState(header: Record<string, any>, origin: Record<string, any>) {
    for (const key of ['claimedBy', 'claimedAt', 'notifiedAt', 'tryClaim', 'preparationAttempt', 'claimAttemptId', 'attemptId', 'executionProvenance'] as const) {
      if (origin[key] === undefined) delete header[key]; else header[key] = origin[key];
    }
    header.profile = origin.profile;
    if (origin.summary && header.attemptId) {
      const summary = { ...origin.summary, executorStarts: header.cacheDisposition === 'executed' ? origin.summary.executorStarts : 0 };
      const startedAt = origin.startedAt ?? header.startedAt ?? now();
      db.prepare('INSERT INTO attempt_summaries VALUES(?,?,?,?,?) ON CONFLICT(request_id,attempt_id) DO UPDATE SET completed_at=excluded.completed_at,data=excluded.data').run(header.id,header.attemptId,startedAt,origin.completedAt ?? null,JSON.stringify(summary));
      header.sourceSummary = origin.summary;
    }
    if (origin.usage && header.attemptId) db.prepare('INSERT INTO request_usage VALUES(?,?,?) ON CONFLICT(request_id,attempt_id) DO UPDATE SET data=excluded.data').run(header.id,header.attemptId,JSON.stringify(origin.usage));
  }
  function captureSourceState(header: Record<string, any>) {
    const source = header.executionSource as ExecutionSource | undefined;
    if (!source || source.stateDir === stateDir) return;
    try { const origin = projectRequestState(source.stateDir, source.requestId); if (origin) copyExecutionState(header,origin); }
    catch { /* Missing diagnostics are explicitly unreported, never invented. */ }
  }
  function mirrorExecution(requestId: string, source: ExecutionSource) {
    if (closed || terminal.has(polling.requestStatus(requestId) ?? 'ERROR')) return;
    const origin = projectRequestState(source.stateDir, source.requestId, false);
    if (!origin) return;
    transaction(() => {
      const header = requestHeader(requestId); if (!header || terminal.has(header.status)) return;
      const before = JSON.stringify(header);
      copyExecutionState(header, origin);
      if (origin.status === 'WAITING_HUMAN') header.status = 'WAITING_HUMAN';
      if (before !== JSON.stringify(header)) saveHeader(header);
    });
    changed();
  }

  async function executeOne(requestId: string, workspace: WorkspaceHandle, token: string, signal: AbortSignal) {
    const initial = required(requestHeader(requestId), 'Request');
    const input = initial.inputRef ? store.get<import('../project/types.js').ValidationInput>(initial.inputRef) : null;
    if (rawExecution || readiness.header(initial.runId)?.executionOwned || diagnosticScope.getStore() || input?.version !== 4 || !input.cacheIdentity) return executeUncached(requestId, workspace, token, signal);
    const runId = initial.runId, request = copy(required(requestData(requestId), 'Request'));
    const service = sharedCache();
    let source: ExecutionSource | undefined, mirror: NodeJS.Timeout | undefined;
    try {
      signal.throwIfAborted();
      transaction(() => {
        const header = required(requestHeader(requestId), 'Request');
        if (header.status !== 'QUEUED' || ownerData(runId)?.token !== token) throw codedError('Review ownership changed before subscription.', 'RUN_OWNERSHIP_LOST');
        header.status = 'RUNNING'; header.startedAt = now(); header.requestedProfile = request.profile;
        saveHeader(header);
      });
      const outcome = await service.compute(input.cacheIdentity, async (executionSignal, executionId): Promise<CachedReview> => {
        const executionState = path.join(service.directory, 'executions', executionId);
        const executor = requireExecutors();
        const owner: ExecutionBroker = createBroker({ repoPath, stateDir: executionState, repoId: 'cache-execution',
          detail: 'full', [executionMode]: true, workspaceAdapter, maxConcurrentExecutors, admission,
          executors: { ...executor, notifyHuman: executor.notifyHuman ? (review, context) => executor.notifyHuman!({ ...review,
            executionSource: { stateDir: executionState, runId: executionId, requestId: executionId, executionId, identity: input.cacheIdentity! } }, context) : undefined },
        });
        try {
          await owner[enqueueExecution](request, copy(workspace.descriptor), executionId, runId);
          await owner.run(executionId, { signal: executionSignal });
          const completed = required(owner.getRequest(executionId), 'shared execution');
          const summary = projectRequestState(executionState,executionId)?.summary;
          if (!closed && summary) transaction(() => { const receipt = requestHeader(requestId); if (receipt) { copyExecutionState(receipt,{...completed,summary}); db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(receipt),requestId); } });
          if (!completed.result) throw codedError(completed.error ?? 'Shared execution did not produce a semantic result.', completed.errorCode ?? 'COMPUTE_FAILED');
          return { result: completed.result, profile: completed.profile, origin: { stateDir: executionState, runId: executionId, requestId: executionId },
            attemptId: completed.attemptId ?? null, executionProvenance: completed.executionProvenance ?? null,
            ...(completed.usage ? { usage: completed.usage } : {}),
            summary,
            definition: { criticId: request.criticId, payload: request.payload, passSchema: request.passSchema, failSchema: request.failSchema, resultCheck: request.resultCheck },
          };
        } finally { await owner.close(); }
      }, { signal, force: Boolean(readiness.header(runId)?.project.force), scope: runId,
        onState(state, executionId) {
          source = { stateDir: path.join(service.directory, 'executions', executionId), runId: executionId, requestId: executionId, executionId, identity: input.cacheIdentity! };
          transaction(() => {
            const header = requestHeader(requestId); if (!header || terminal.has(header.status)) return;
            header.executionSource = source; header.cacheDisposition = state === 'executing' ? 'executed' : state;
            saveHeader(header);
            appendEvent(runId, requestId, `request.cache.${state}`, 'Subscribed to an explicit-identity computation.', { executionId });
          });
          mirror ??= setInterval(() => { try { if (source) mirrorExecution(requestId, source); } catch { /* Terminal cache publication remains authoritative. */ } }, 100);
        },
      });
      signal.throwIfAborted();
      transaction(() => {
        const header = requestHeader(requestId); if (!header || terminal.has(header.status) || ownerData(runId)?.token !== token) return;
        header.executionSource = cacheSource(outcome.entry);
        header.cacheDisposition = outcome.disposition;
        header.profile = outcome.entry.value.profile;
        header.attemptId = outcome.entry.value.attemptId;
        header.executionProvenance = outcome.entry.value.executionProvenance;
        header.sourceSummary = outcome.entry.value.summary;
        saveHeader(header);
        if (outcome.entry.value.usage && header.attemptId) addUsage(requestId, header.attemptId, outcome.entry.value.usage);
        // The owner already validated its schema and input. Applying a different
        // subscriber schema here would silently introduce another cache key.
        finishWithin(requestId, { result: outcome.entry.value.result, executionProvenance: outcome.entry.value.executionProvenance });
      });
      changed();
    } catch (cause) {
      if (signal.aborted || fatalExecutionError(cause)) throw signal.aborted ? signal.reason : cause;
      transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { error: cause }, ['QUEUED','RUNNING','WAITING_HUMAN']); });
      changed();
    } finally { clearInterval(mirror); }
  }

  async function executeUncached(requestId: string, workspace: WorkspaceHandle, token: string, signal: AbortSignal) {
    const initial = required(requestHeader(requestId), 'Request');
    const runId = initial.runId;
    let lease: ResourceLease | undefined;
    let customLease: AdmissionLease | undefined;
    try {
      if (initial.profile.kind !== 'human') {
        const admissionRequest = { requestId, runId: readiness.header(runId)?.budgetRunId ?? runId, kind: initial.profile.kind, provider: initial.profile.provider, model: initial.profile.model };
        // Optional admission is a stricter precondition, never the machine authority.
        customLease = await admission?.acquire(admissionRequest, { signal, waiting(reason) { transaction(() => { const current = required(requestHeader(requestId), 'Request'); if (current.status !== 'QUEUED') return; current.blockedReason = reason.slice(0, 2000); saveHeader(current); }); changed(); } });
        const caps = [maxConcurrentExecutors, readiness.header(runId)?.repoExecutorCap].filter((value): value is number => value !== undefined);
        lease = await resources.acquire({ ...admissionRequest, repo: repositoryKey, ...(caps.length ? { repoCap: Math.min(...caps) } : {}) }, { signal, waiting(reason) {
        transaction(() => { const current = required(requestHeader(requestId), 'Request'); if (current.status !== 'QUEUED') return; current.blockedReason = reason.slice(0, 2000); saveHeader(current); }); changed();
      } });
      }
      signal.throwIfAborted();
    transaction(() => {
      const request = required(requestHeader(requestId), 'Request');
      if (ownerData(runId)?.token !== token || request.status !== 'QUEUED') throw codedError('Review ownership changed before execution.', 'RUN_OWNERSHIP_LOST');
      request.status = 'RUNNING'; request.startedAt = now(); request.blockedReason = null; saveHeader(request);
      appendEvent(runId, request.id, 'request.started', `${request.title}: reviewing the supplied workspace.`, { snapshotHash: workspace.descriptor.hash });
      updateRunStatus(runId);
    });
    changed();
    try {
      signal.throwIfAborted();
      await workspace.assertUnchanged();
      const request = required(requestData(requestId), 'Request');
      const runDir = path.join(stateDir, 'runs', runId, request.id);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      if (required(readiness.header(runId), 'Run').project) {
        const capability = await requireExecutors().canExecute(copy(request));
        if (!capability?.ok) throw codedError(capability?.reason ?? 'No compatible executor.', capability?.code ?? 'EXECUTOR_UNAVAILABLE');
      }
      if (request.profile.kind === 'human') {
        if (typeof requireExecutors().notifyHuman !== 'function') throw new Error('Human execution requires a registered alarm method.');
        transaction(() => {
          const current = required(requestData(requestId), 'Request');
          if (current.status !== 'RUNNING') throw codedError('Review was canceled before Human notification.', 'REVIEW_CANCELED');
          current.status = 'WAITING_HUMAN'; current.attemptId = randomUUID();
          beginAttempt(db,requestId,current.attemptId,now(),0); saveRequest(current);
          appendEvent(runId, requestId, 'human.waiting', 'Human review is ready; registered alarm delivery is pending.');
          updateRunStatus(runId);
        });
        await requireExecutors().notifyHuman!(copy(required(requestData(requestId), 'Request')), { signal });
        signal.throwIfAborted();
        await workspace.assertUnchanged();
        transaction(() => {
          const current = required(requestData(requestId), 'Request');
          if (current.status !== 'WAITING_HUMAN') return;
          current.notifiedAt = now(); saveRequest(current);
          appendEvent(runId, requestId, 'human.notified', 'Registered human alarm methods confirmed delivery.');
        });
        changed();
        return;
      }
      const capture = await captureExecution(request, lease!.token, signal);
      // Fence cancellation and ownership after every preparation await. Holding the
      // repository write lock orders remote cancel against the committed start marker.
      // There is no await or user callback between this guard and invocation.
      transaction(() => {
        signal.throwIfAborted();
        const header = required(requestHeader(requestId), 'Request');
        if (ownerData(runId)?.token !== token) throw codedError('Review ownership changed before executor start.', 'RUN_OWNERSHIP_LOST');
        if (header.status !== 'RUNNING' || terminal.has(required(polling.runStatus(runId), 'Run'))) throw codedError('Review was canceled before executor start.', 'REVIEW_CANCELED');
        lease!.started(capture?.provenance ?? null);
        header.attemptId = lease!.token; header.executionProvenance = capture?.provenance ?? null;
        beginAttempt(db,requestId,lease!.token,now(),1);
        db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(header), requestId);
      });
      // This attempt's argument record, kept apart from metadata-only events and written while
      // RUNNING, so cancellation and worker death keep it. Past either bound, later calls are only counted.
      let recordedOrdinal = 0, recordedBytes = 0, recording = true;
      const recordToolCall = (metadata: Record<string, unknown>, event: ExecutionEvent) => {
        const args = object(event.arguments) ? event.arguments : {}, bytes = Buffer.byteLength(JSON.stringify(args));
        recording &&= recordedOrdinal < RECORDED_TOOL_CALLS && recordedBytes + bytes <= RECORDED_ARGUMENT_BYTES;
        if (recording) recordedBytes += bytes;
        const at = typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at) ? event.at : now();
        const entry = { name: metadata.name, arguments: args, at, ...(metadata.isError ? { isError: true } : {}), ...(metadata.observation ? { observation: metadata.observation } : {}) };
        db.prepare('INSERT INTO tool_call_records(request_id,attempt_id,ordinal,data) VALUES (?,?,?,?)').run(requestId, lease!.token, recordedOrdinal++, recording ? JSON.stringify(entry) : null);
      };
      const result = validateResult(await executionScope.run({ runtimeRoot: capture?.root ?? workspace.descriptor.path, declaredPaths: capture?.paths ?? [], trackChild: pid => lease!.trackChild(pid) }, () => requireExecutors().execute(copy(request), {
        worktreePath: workspace.descriptor.path, workspacePath: workspace.descriptor.path, runDir, signal,
        onEvent(event) {
          if (closed || closing || signal.aborted || !event || polling.requestStatus(requestId) !== 'RUNNING' || !['executor.started', 'artifact.tools.ready', 'artifact.tool.called', 'artifact.tool.completed', 'executor.usage', 'executor.final.invalid', 'executor.final.repair', 'executor.telemetry.failed', 'executor.provider.retry', 'executor.completed'].includes(event.type)) return;
          if (event.type === 'executor.final.invalid' || event.type === 'executor.final.repair') {
            const safe = finalResultEventData(event);
            if (safe) { appendEvent(runId, requestId, event.type, event.type, safe); changed(); }
            return;
          }
          const safe: Record<string, unknown> = {};
          for (const key of ['name', 'provider', 'model', 'kind', 'artifactId', 'path']) if (typeof event[key] === 'string') safe[key] = (event[key] as string).slice(0, 1000);
          if (event.type === 'artifact.tool.completed') {
            Object.assign(safe, toolResponseBytes(event));
            if (typeof event.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.startedAt) && Number.isFinite(Date.parse(event.startedAt))) safe.startedAt = event.startedAt;
            if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) safe.durationMs = event.durationMs;
            if (event.outcome === 'success' || event.outcome === 'error') safe.outcome = event.outcome;
            if (typeof event.operation === 'string') safe.operation = event.operation.slice(0, 1000);
          }
          if (event.type === 'executor.provider.retry') {
            appendEvent(runId, requestId, event.type, 'Provider turn is retrying before content was delivered.', {
              attempt: Number.isSafeInteger(event.attempt) ? event.attempt : undefined, delayMs: Number.isSafeInteger(event.delayMs) ? event.delayMs : undefined,
              code: ['RATE_LIMITED', 'PROVIDER_TRANSIENT_FAILURE'].includes(String(event.code)) ? event.code : undefined, usageState: 'unreported',
            }); changed(); return;
          }
          if (event.type === 'executor.usage') {
            const usage = tokenUsage(event.usage);
            if (!usage) return;
            safe.usage = usage;
          }

          if (event.isError === true) safe.isError = true;
          if (object(event.observation)) {
            // Persist the same bounded metadata as final results, even if the Provider later fails.
            const observed = storedObservation(event.observation, event.isError === true);
            if (observed) safe.observation = observed;
          }
          if (Array.isArray(event.tools)) safe.tools = event.tools.slice(0, 32).map(tool => typeof tool === 'string' ? tool : tool?.name).filter(value => typeof value === 'string');
          const message = event.type === 'executor.telemetry.failed' ? 'Some optional execution diagnostics could not be recorded.' : String(event.message ?? event.type).slice(0, 2000);
          // A usage event and its attempt sum commit together or not at all.
          if (event.type === 'executor.usage') transaction(() => { appendEvent(runId, requestId, event.type, message, safe); addUsage(requestId, lease!.token, safe.usage as Record<string, number>); });
          else appendEvent(runId, requestId, event.type, message, safe);
          if (event.type === 'artifact.tool.called') { recordToolCall(safe, event); recordAttemptTool(db,requestId,lease!.token,String(object(safe.observation) ? safe.observation.operation : safe.name ?? '(unknown)')); }
          changed();
        },
      })));
      await capture?.verify();
      validateFinalResult(semanticResult(result), request);
      await workspace.assertUnchanged();
      signal.throwIfAborted();
      transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { result, executionProvenance: capture?.provenance ?? null }); });
      changed();
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      if (signal.aborted || fatalExecutionError(reason)) throw reason;
      transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { error: reason }); });
      changed();
    }
    } catch (error) { if (signal.aborted || fatalExecutionError(error)) throw error; transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { error }, ['QUEUED']); }); changed(); } finally {
      const cleanupErrors: string[] = [];
      try { lease?.terminal(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { await lease?.release(); } catch (error) { cleanupErrors.push(errorText(error)); }
      try { await customLease?.release(); } catch (error) { cleanupErrors.push(errorText(error)); }
      if (cleanupErrors.length) { appendEvent(runId, requestId, 'resource.cleanup.error', 'Execution resource cleanup failed; retained leases stay authoritative.', { errors: cleanupErrors }); changed(); }
    }
  }

  async function run(runId: string, { signal, onStarted }: { signal?: AbortSignal; onStarted?: (value: { runId: string; pid: number }) => void } = {}) {
    ensureOpen(); requireExecutors();
    const token = randomUUID();
    let stored: RunRecord | null = null;
    const acquired = transaction(() => {
      reconcileWithin(runId);
      const header = readiness.header(runId);
      stored = header ? { ...header, workspace: store.get(header.workspaceRef) } : null;
      if (!stored) throw new Error('Unknown Run.');
      if (stored.workerProtocol !== 'resources-1') throw new Error('This Run uses an old worker protocol. Stop all 6.0 workers, preserve their history, and submit a new Run.');
      if (!stored.executionOwned && Object.values(required(runData(runId), 'Run').project?.snapshot.inputs ?? {}).some(input => input.version !== 4)) throw new Error('Historical composite identities are audit-only. Submit a new Run with explicit identities.');
      if (stored.project?.version !== 3) throw new Error('Invalid stored Run format; submit a new validation request.');
      if (terminal.has(stored.status)) return false;
      if (!stored.workspace) throw new Error('Invalid Run: no workspace descriptor.');
      if (ownerData(runId)) throw codedError('Another process already owns this review Run.', 'RUN_ALREADY_OWNED');
      submissionDeadlines.delete(runId);
      db.prepare('INSERT INTO run_owners(run_id,pid,process_identity,token,claimed_at) VALUES (?,?,?,?,?)').run(runId, process.pid, ownProcessIdentity, token, now());
      appendEvent(runId, null, 'worker.started', 'A request-scoped worker owns this Run.', { pid: process.pid });
      return true;
    });
    if (!acquired) return getRun(runId);
    const ownedRun = required<RunRecord>(stored, 'Run');
    const abort = new AbortController();
    const executionSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const entry: ActiveRun = { runId, token, abort, promise: null };
    active.set(token, entry);
    entry.promise = (async () => {
      let workspace: WorkspaceHandle | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const inFlight = new Map<string, { kind: ReviewRequest['profile']['kind']; promise: Promise<void> }>();
      let plannedRevision = -1, leaseDeadline = Infinity;
      let pendingSources: string[] = [];
      const notified = new Set<string>();
      try {
        onStarted?.({ runId, pid: process.pid });
        workspace = await workspaceAdapter.reopenWorkspace(copy(ownedRun.workspace), { signal: executionSignal });
        const reviewSignal = AbortSignal.any([executionSignal, workspace.signal]);
        poll = setInterval(() => {
          if (ownerData(runId)?.token !== token) abort.abort(codedError('Review ownership was lost.', 'RUN_OWNERSHIP_LOST'));
          else if (terminal.has(required(polling.runStatus(runId), 'Run'))) abort.abort(codedError('Review is already complete or canceled.', 'REVIEW_CANCELED'));
        }, 100);
        while (true) {
          const current = required(polling.runStatus(runId), 'Run');
          if (terminal.has(current)) {
            if (inFlight.size) abort.abort(codedError('Review is already complete or canceled.', 'REVIEW_CANCELED'));
            break;
          }
          reviewSignal.throwIfAborted();
          const sourceExited = pendingSources.some(id => { const owner = ownerData(id); return owner !== undefined && !ownerAlive(owner); });
          if (polling.revision() !== plannedRevision || performance.now() >= leaseDeadline || sourceExited) transaction(() => {
            refreshReadinessWithin(runId); updateRunStatus(runId);
            const pending = sharedRequests({ id: runId }).filter(request => !terminal.has(request.status));
            pendingSources = [...new Set(pending.map(request => request.runId))];
            leaseDeadline = Math.min(Infinity, ...pendingSources.filter(id => !ownerData(id)).map(id => submissionDeadlines.get(id) ?? performance.now()));
            plannedRevision = polling.revision();
          });
          const requests = db.prepare("SELECT id,status,json_extract(data,'$.profile.kind') AS kind FROM requests WHERE run_id=? AND status='QUEUED' ORDER BY ordinal LIMIT ?").all(runId, Math.min(localCap + inFlight.size + 1, 2147483647)) as unknown as { id: string; status: ReviewStatus; kind: ReviewRequest['profile']['kind'] }[];
          let executing = [...inFlight.values()].filter(item => item.kind !== 'human').length;
          for (const row of requests.filter(request => request.status === 'QUEUED' && !inFlight.has(request.id))) {
            const kind = row.kind;
            if (kind !== 'human' && executing >= localCap) continue;
            if (kind !== 'human') executing++;
            const promise = executeOne(row.id, workspace, token, reviewSignal).catch(error => {
              // A different task may win Promise.race before this rejection. Preserve fatal failure independently of that race.
              abort.abort(error);
              throw error;
            }).finally(() => { inFlight.delete(row.id); });
            inFlight.set(row.id, { kind, promise });
          }
          if (inFlight.size) {
            // Human alarms and independent evaluations progress together.
            await Promise.race([...inFlight.values()].map(item => item.promise).concat(delay(50, undefined, { signal: reviewSignal })));
            continue;
          }
          if (pendingSources.length) {
            brokerTestHooks.onIdleTick?.();
            await delay(Math.max(1, Math.min(100, leaseDeadline - performance.now())), undefined, { signal: reviewSignal });
            continue;
          }
          const waiting = db.prepare("SELECT id FROM requests WHERE run_id=? AND status='WAITING_HUMAN' ORDER BY ordinal LIMIT 1").all(runId) as unknown as { id: string }[];
          if (waiting.length) {
            for (const request of waiting) {
              if (notified.has(request.id)) continue;
              if (!required(requestData(request.id), 'Request').notifiedAt) throw new Error('Human notification did not complete; submit a new Run to retry.');
              notified.add(request.id);
            }
            // The workspace observer stays alive with filesystem events and metadata polls.
            // Notification already crossed its final content boundary; idle waiting
            // must not rehash the entire workspace on every scheduling iteration.
            brokerTestHooks.onIdleTick?.();
            await delay(100, undefined, { signal: reviewSignal });
            continue;
          }
          if (terminal.has(required(polling.runStatus(runId), 'Run'))) break;
          throw codedError('Run has no executable request or pending Human review.', 'REVIEW_GRAPH_INVALID');
        }
      } catch (error) {
        const reason = workspace?.signal.aborted ? workspace.signal.reason : executionSignal.aborted ? executionSignal.reason : error;
        abort.abort(reason);
        failOwned(runId, token, reason);
      } finally {
        clearInterval(poll);
        await Promise.allSettled([...inFlight.values()].map(item => item.promise));
        try { await workspace?.close(); }
        catch (error) {
          failOwned(runId, token, error);
          appendEvent(runId, null, 'worker.cleanup.error', `Workspace monitoring cleanup failed: ${errorText(error)}`);
        } finally {
          transaction(() => { db.prepare('DELETE FROM run_owners WHERE run_id = ? AND token = ?').run(runId, token); });
          active.delete(token);
          changed();
        }
      }
      // close() can be awaiting this promise; read directly before it closes the DB.
      return detail === 'full' ? { ...copy(required(runData(runId), 'Run')), requests: runRequests(runId) } : { ...ownedRun, requests: [] };
    })();
    return entry.promise;
  }

  const broker = {
    async [enqueueExecution](request: ReviewRequest, descriptor: WorkspaceDescriptor, id: string, budgetRunId: string): Promise<void> {
      if (!rawExecution) throw new Error('Only the cache may enqueue an execution record.');
      const record = executionRecord(copy(request), descriptor, id, budgetRunId);
      const prepared = await store.prepareRun(record);
      resources.registerSubmission(id, undefined);
      transaction(() => {
        prepared.verify();
        db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES(?,?,?,?)').run(id,record.createdAt,record.status,JSON.stringify(prepared.header));
        readiness.initialize(record, prepared);
      });
    },
    async submitProject({ [preparedInput]: ready, profile, requesterId = 'cli', selection, recursive = false, force = false, ignoreGates, maxExecutions, signal, identityConcurrency: submissionIdentityConcurrency = identityConcurrency, ...removed }: { [preparedInput]?: ReturnType<typeof preparedProjectData>; profile?: ProfileSelection; requesterId?: string; selection: ProjectSelection; recursive?: boolean; force?: boolean; ignoreGates?: boolean; maxExecutions?: number; signal?: AbortSignal; identityConcurrency?: number }) {
      // Options are destructured before entry; selection is the sole mutable data
      // input. Keep signal live for cancellation rather than cloning its state.
      selection = structuredClone(selection); profile = structuredClone(profile);
      ensureOpen(); requireExecutors(); sweepSubmissionDeadlines();
      rejectIdentityConcurrency(submissionIdentityConcurrency); validateMaxExecutions(maxExecutions);
      if ('mode' in removed) throw new Error('Workspace modes are no longer supported; supply an unchanged workspace.');
      if (!requesterId.trim() || requesterId.length > 200) throw new Error('requesterId is required (maximum 200 characters).');
      await requireExecutors().validateWorkspace?.(repoPath);
      const workspace = ready ? await workspaceAdapter.reopenWorkspace(ready.descriptor, { signal }) : await workspaceAdapter.prepareWorkspace({ repoPath, stateDir, integrity: workspaceIntegrity, signal });
      try {
        // A custom adapter may retain a mutable descriptor. Snapshot it once,
        // before any later await, and never store its externally owned object.
        const descriptor = structuredClone(workspace.descriptor);
        const config = ready?.config ?? selectProfiles((await readWorkspaceConfig(descriptor.path, workspace.signal)).config, profile, selection, recursive);
        ignoreGates ??= config.reviewPolicy?.dependencyGates === 'ignore';
        const snapshot = ready?.snapshot ?? await createProjectSnapshot(config, descriptor.path, descriptor.hash, workspace.signal, descriptor.integrity, selection, { identityConcurrency: submissionIdentityConcurrency });
        const ids = includedCritics(snapshot, selection, recursive);
        const templates: ReviewEnvelope[] = ready?.templates ?? [];
        const critics = new Map(config.critics.map(critic => [critic.id, critic]));
        for (const id of ready ? [] : ids) { templates.push(...await prepareReviewRequests({ repoPath: descriptor.path, repoId, snapshotHash: descriptor.hash, criticId: id, preparedConfig: { ...config, critics: [critics.get(id)!] }, copy: false })); if (templates.length % 16 === 0) { workspace.signal.throwIfAborted(); await yieldTurn(); } }

        const id = randomUUID(), createdAt = now();
        const record: RunRecord = { id, repoId, workerProtocol: 'resources-1', maxExecutions, repoExecutorCap: config.reviewPolicy?.maxConcurrentExecutors, coalescingGraceMs, snapshotHash: descriptor.hash, workspace: descriptor, requesterId,
          scope: { kind: 'project' }, graph: createGraphDefinition(config, false), project: { version: 3, snapshot, selection, recursive, force, ignoreGates, templates }, status: 'QUEUED', createdAt };
        const cached = snapshotCache(snapshot), sharedActive = snapshotActive(snapshot);
        const prepared = await store.prepareRun(record, workspace.signal);
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted();
        ensureOpen();
        const commitStarted = performance.now();
        resources.registerSubmission(id, maxExecutions);
        transaction(() => {
          prepared.verify();
          db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?)').run(id, createdAt, record.status, JSON.stringify(prepared.header));
          appendEvent(id, null, 'run.submitted', 'Project validation requested against fixed input.', { selection, recursive, force });
          brokerTestHooks.onPlan?.(); readiness.initialize(record, prepared, cached);
          if (maxExecutions !== undefined) {
            const starts = new Set(db.prepare("SELECT id,data FROM requests WHERE run_id=? AND status='QUEUED' AND json_extract(data,'$.profile.kind')!='human'").all(id).flatMap(row => {
              const header = JSON.parse(String(row.data)), input = snapshot.inputs[header.criticId];
              if (!force && input.cacheIdentity && sharedActive.has(input.cacheIdentity)) return [];
              return [input.cacheIdentity ?? String(row.id)];
            })).size;
            if (starts > maxExecutions) throw codedError(`Plan requires ${starts} new executions, exceeding maxExecutions ${maxExecutions}.`, 'EXECUTION_BUDGET_EXCEEDED');
          }
        });
        brokerTestHooks.onSubmissionCommit?.(performance.now() - commitStarted);
        changed(); return detail === 'full' ? required(getRun(id), 'Run') : { ...record, scope: record.scope!, requests: [], events: [], owner: null };
      } finally { await workspace.close(); }
    },
    run,
    executionBudget(id: string) { ensureOpen(); return resources.budget(id); },
    reconcile,
    listRuns() {
      ensureOpen();
      return db.prepare('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC').all().map(row => {
        const record = required(getRun(String(row.id)), 'Run');
        return record;
      });
    },
    getRun,
    getRequest(id: string) {
      ensureOpen();
      const request = requestData(id);
      if (request) reconcile(request.runId);
      return requestData(id);
    },
    tryClaimHuman(requestId: string, reviewerId: string, options: { leaseMs?: number } = {}) {
      ensureOpen();
      const existing = requestData(requestId);
      if (existing) reconcile(existing.runId);
      return humanClaims.begin(requestId, reviewerId, options.leaseMs);
    },
    renewHumanTryClaim: humanClaims.renew,
    releaseHumanTryClaim: humanClaims.release,
    async claimHuman(requestId: string, reviewerId: unknown, { signal }: { signal?: AbortSignal } = {}) {
      ensureOpen();
      if (typeof reviewerId !== 'string' || !reviewerId.trim()) throw new Error('A reviewerId is required.');
      const existing = requestData(requestId);
      if (existing) reconcile(existing.runId);
      const request = required(requestData(requestId), 'request');
      if (request.configManifest?.version !== 2) throw new Error('Invalid stored review configuration.');
      if (request.status === 'WAITING_HUMAN' && request.claimedBy === reviewerId) return request;
      if (request.claimedBy) throw new Error('This review is already claimed by another reviewer.');
      signal?.throwIfAborted();
      const attempt = humanClaims.begin(requestId, reviewerId);
      const controller = new AbortController();
      const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const heartbeat = setInterval(() => {
        try { humanClaims.renew(requestId, reviewerId, attempt.id); }
        catch (error) { controller.abort(error); }
      }, Math.min(5_000, HUMAN_PREPARATION_LEASE_MS / 3));
      try {
        const prepared = await prepareHumanReview(request, request.workspace, path.join(stateDir, 'runs', request.runId, request.id, 'preparation', attempt.id), executionSignal,
          progress => humanClaims.progress(requestId, reviewerId, attempt.id, progress));
        executionSignal.throwIfAborted();
        humanClaims.progress(requestId, reviewerId, attempt.id, { phase: 'confirming-assignment' });
        return humanClaims.confirm(requestId, reviewerId, attempt.id, prepared);
      } catch (error) {
        const code = errorCode(error);
        humanClaims.release(requestId, reviewerId, attempt.id, signal?.aborted ? 'cancelled' : code === 'HUMAN_PREPARATION_FAILED' ? 'checks-failed' : typeof code === 'string' && code.startsWith('WORKSPACE_') ? 'input-invalid' : 'preparation-failed');
        throw error;
      } finally { clearInterval(heartbeat); }
    },
    async executeHumanTool(requestId: string, { reviewerId, toolName, arguments: args = {}, signal }: { reviewerId: unknown; toolName: string; arguments?: unknown; signal?: AbortSignal }) {
      ensureOpen();
      const first = requestData(requestId);
      if (first) reconcile(first.runId);
      const assertClaim = () => {
        ensureOpen();
        const current = requestData(requestId);
        if (!current || current.profile.kind !== 'human' || current.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
        if (current.configManifest?.version !== 2) throw new Error('Invalid stored review configuration.');
        if (!reviewerId || current.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can use its tools.');
        if (!ownerAlive(ownerData(current.runId))) throw new Error('An in-place review requires its monitoring worker to remain alive.');
        return current;
      };
      const request = assertClaim();
      let workspace: WorkspaceHandle | undefined;
      let inputsValidated = false;
      try {
        workspace = await workspaceAdapter.reopenWorkspace(request.workspace, { signal });
        // Reopening already validates the complete input. The post-tool check below
        // remains mandatory because configuration loading and tool execution can mutate it.
        workspace.signal.throwIfAborted();
        inputsValidated = true;
        let timing: ToolExecutionDiagnostic | undefined;
        const registry = await createReviewTools({
          onExecution: diagnostic => { timing = diagnostic; },
          worktreePath: workspace.descriptor.path, artifacts: request.artifacts,
          configManifest: request.configManifest, criticId: request.criticId, audience: 'human',
          runDir: path.resolve(stateDir, 'runs', request.runId, request.id, 'human-tools'), signal: workspace.signal,
        });
        try {
          registry.validateArguments(toolName, args);
          assertClaim();
          const attempt = await registry.call(toolName, args).then(result => ({ ok: true as const, result }), error => ({ ok: false as const, error: error as unknown }));
          await workspace.assertUnchanged(); workspace.signal.throwIfAborted(); assertClaim();
          if (timing) {
            const record = () => transaction(() => {
              assertClaim();
              recordAttemptTool(db,requestId,requestHeader(requestId)?.attemptId,timing!.operation);
              appendEvent(request.runId, requestId, 'human.tool.executed', 'The claimed reviewer attempted a registered Artifact tool.', { ...timing, ...(attempt.ok && attempt.result.isError ? { isError: true } : {}) });
            });
            if (attempt.ok) record(); else { try { record(); } catch { /* Optional failure diagnostics never replace the original error. */ } }
            changed();
          }
          if (!attempt.ok) throw attempt.error;
          return attempt.result;
        } finally { await registry.close(); }
      } catch (error) {
        const failure = workspace?.signal.aborted && !signal?.aborted ? workspace.signal.reason ?? error : error;
        if (!signal?.aborted && (!inputsValidated || errorCode(failure)?.startsWith('WORKSPACE_'))) {
          transaction(() => {
            if (requestData(requestId)?.status === 'WAITING_HUMAN') failWithin(request.runId, failure);
          });
          changed();
        }
        throw failure;
      } finally { await workspace?.close(); }
    },
    async completeHuman(requestId: string, { reviewerId, result }: { reviewerId: unknown; result: unknown }) {
      ensureOpen();
      const definition = required(requestData(requestId), 'Request');
      validateFinalResult(result, definition);
      const validated = validateResult(result, definition);
      const first = requestData(requestId);
      if (first) reconcile(first.runId);
      const request = requestData(requestId);
      if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
      if (request.configManifest?.version !== 2) throw new Error('Invalid stored review configuration.');
      if (!reviewerId || request.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
      if (!request.notifiedAt) throw new Error('Human alarm delivery is still pending.');
      let workspace: WorkspaceHandle | undefined;
      let inputsValidated = false;
      try {
        workspace = await workspaceAdapter.reopenWorkspace(request.workspace);
        // Reopening validates input under its integrity policy. No asynchronous work or
        // user code runs between this boundary and committing the submitted result.
        workspace.signal.throwIfAborted(); ensureOpen();
        inputsValidated = true;
        transaction(() => {
          const current = required(requestData(requestId), 'Request');
          if (current.status !== 'WAITING_HUMAN') throw new Error('This human review has already completed or failed.');
          if (current.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
          if (!ownerAlive(ownerData(current.runId))) throw new Error('An in-place review requires its monitoring worker to remain alive.');
          required(workspace, 'Workspace').signal.throwIfAborted();
          finishWithin(requestId, { result: validated });
        });
      } catch (error) {
        // A workspace failure invalidates the review; a competing completed result is immutable.
        if (!inputsValidated || errorCode(error)?.startsWith('WORKSPACE_')) {
          transaction(() => { if (requestData(requestId)?.status === 'WAITING_HUMAN') failWithin(request.runId, error); }); changed();
        }
        throw error;
      } finally { await workspace?.close(); }
      changed();
      return requestData(requestId);
    },
    failRun(runId: string, error: unknown) {
      ensureOpen();
      transaction(() => {
        reconcileWithin(runId);
        if (!polling.runStatus(runId)) throw new Error('Unknown Run.');
        if (ownerData(runId)) throw codedError('Another process already owns this review Run.', 'RUN_ALREADY_OWNED');
        failWithin(runId, error instanceof Error ? error : new Error(errorText(error)));
      });
      changed(); return getRun(runId);
    },
    cancel(runId: string) {
      ensureOpen();
      const error = codedError('Review canceled by requester.', 'REVIEW_CANCELED');
      transaction(() => {
        if (!polling.runStatus(runId)) throw new Error('Unknown Run.');
        failWithin(runId, error);
      });
      for (const entry of active.values()) if (entry.runId === runId) entry.abort.abort(error);
      changed(); return getRun(runId);
    },
    retryRequest(requestId: string) {
      ensureOpen();
      transaction(() => {
        const request = required(requestHeader(requestId), 'Request');
        if (request.status !== 'ERROR') throw new Error('Only an operationally failed request can be retried. Submit changed input as a new Run.');
        const run = required(readiness.header(request.runId), 'Run');
        if (ownerData(run.id)) throw codedError('Wait for the current worker to settle before retrying.', 'RUN_ALREADY_OWNED');
        run.status = 'QUEUED'; delete run.completedAt; delete run.error;
        db.prepare('UPDATE runs SET status=?,data=? WHERE id=?').run(run.status, JSON.stringify(run), run.id);
        const gate = db.prepare('SELECT unmet,red FROM gate_counts WHERE run_id=? AND critic_id=?').get(request.runId,request.criticId);
        request.status = Number(gate?.unmet ?? 0) ? Number(gate?.red ?? 0) ? 'BLOCKED' : 'WAIT_DEPENDENCY' : 'QUEUED'; request.error = null; request.errorCode = null; request.resultRef = null; request.semanticRef = null; request.startedAt = null; request.completedAt = null; delete request.executionProvenance; delete request.attemptId; delete request.executionSource; delete request.cacheDisposition; delete request.sourceSummary;
        saveHeader(request);
        // The new attempt starts without a record; the failed one is no longer shown.
        db.prepare('DELETE FROM tool_call_records WHERE request_id=?').run(request.id);
        // Prior attempt usage stays addressable by its immutable attempt ID.
        appendEvent(run.id, request.id, 'request.retried', 'Retry requested against the same immutable input.');
      });
      changed(); return viewRequest(requestData(requestId));
    },
    results(runId: string, options?: import('../project/results.js').ResultStreamOptions) { ensureOpen(); return streamProjectResults(stateDir,runId,options); },
    requestSummary(requestId: string) { ensureOpen(); return projectRequestSummary(stateDir,requestId); },
    runSummary(runId: string) { ensureOpen(); return projectRunSummary(stateDir,runId); },
    changes(runId: string, options?: ChangeOptions) {
      ensureOpen(); db.exec('BEGIN');
      try { const page = readChanges(db, runId, stateDir, options); db.exec('COMMIT'); return page; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    onChange(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback); },
    async close() {
      if (closed) return;
      if (closing) { await Promise.allSettled([...active.values()].map(entry => entry.promise)); return; }
      closing = true;
      const owned = [...active.values()];
      for (const entry of owned) entry.abort.abort(codedError('The review worker stopped before completion.', 'WORKER_STOPPED'));
      await Promise.allSettled(owned.map(entry => entry.promise));
      await cache?.close();
      await Promise.allSettled([...peers.values()].map(peer => peer.close())); peers.clear();
      clearReadCaches(); submissionDeadlines.clear(); listeners.clear(); db.close(); resources.close(); closed = true;
    },
  };
  const humanPeer = (id: string): { peer: ExecutionBroker; source: ExecutionSource } | null => {
    const request = requestData(id), source = request?.executionSource;
    if (rawExecution || !source || terminal.has(request!.status)) return null;
    let peer = peers.get(source.stateDir);
    if (!peer) { peer = createBroker({ ...readStateContext(source.stateDir), detail: 'full', [executionMode]: true }); peers.set(source.stateDir, peer); }
    return { peer, source };
  };
  const viewRun = <T extends Parameters<typeof requesterRun>[0] | null>(value: T) => resultView({ detail }, value, () => value ? storedRequesterRun(db, value.id, stateDir) ?? requesterRun(value, stateDir) : null);
  const viewRequest = (value: ReviewRequest | null) => resultView({ detail }, value, () => value ? requesterRequest(value, stateDir) : null);
  return {
    ...broker,
    async prepareProject(options: Omit<PrepareProjectOptions, 'repoPath' | 'stateDir' | 'repoId' | 'workspaceIntegrity'>) {
      ensureOpen();
      const { signal, ...rest } = options; const frozen = structuredClone(rest);
      await requireExecutors().validateWorkspace?.(repoPath);
      return prepareProject({ ...frozen, signal, repoPath, stateDir, repoId, workspaceIntegrity });
    },
    async submitPrepared(handle: PreparedProject, options: { requesterId?: string; maxExecutions?: number; signal?: AbortSignal } = {}) {
      const ready = preparedProjectData(handle);
      if (ready.descriptor.path !== repoPath || ready.descriptor.stateDir !== stateDir || (ready.descriptor.integrity ?? 'content') !== workspaceIntegrity) throw new Error('Prepared Project belongs to a different workspace, store or integrity policy.');
      const { selection, recursive, force, ignoreGates } = ready;
      return viewRun(await broker.submitProject({ ...options, selection, recursive, force, ignoreGates, [preparedInput]: ready }))!;
    },
    submitProject: async (...args: Parameters<typeof broker.submitProject>) => viewRun(await broker.submitProject(...args))!,
    run: async (...args: Parameters<typeof broker.run>) => viewRun(await broker.run(...args)),
    getRun: (id: string) => { ensureOpen(); if (ownerData(id)) reconcile(id); return resultView({ detail }, detail === 'full' ? broker.getRun(id) : null, () => storedRequesterRun(db, id, stateDir)); },
    listRuns: () => { ensureOpen(); return db.prepare('SELECT id FROM runs ORDER BY created_at DESC,rowid DESC').all().map(row => { const id = String(row.id); return resultView({ detail }, detail === 'full' ? required(broker.getRun(id), 'Run') : null!, () => required(storedRequesterRun(db, id, stateDir), 'Run')); }); },
    getRequest: (id: string) => viewRequest(broker.getRequest(id)),
    tryClaimHuman: (id: string, reviewer: string, options?: { leaseMs?: number }) => { const target = humanPeer(id); return target ? target.peer.tryClaimHuman(target.source.requestId,reviewer,options) : broker.tryClaimHuman(id,reviewer,options); },
    renewHumanTryClaim: (...args: Parameters<typeof humanClaims.renew>) => { const target = humanPeer(args[0]); return target ? target.peer.renewHumanTryClaim(target.source.requestId,...args.slice(1)) : humanClaims.renew(...args); },
    releaseHumanTryClaim: (...args: Parameters<typeof humanClaims.release>) => { const target = humanPeer(args[0]); return target ? target.peer.releaseHumanTryClaim(target.source.requestId,...args.slice(1)) : humanClaims.release(...args); },
    claimHuman: async (...args: Parameters<typeof broker.claimHuman>) => {
      const target = humanPeer(args[0]);
      if (!target) return viewRequest(await broker.claimHuman(...args))!;
      await target.peer.claimHuman(target.source.requestId,...args.slice(1)); mirrorExecution(args[0],target.source);
      return viewRequest(requestData(args[0]))!;
    },
    executeHumanTool: async (...args: Parameters<typeof broker.executeHumanTool>) => { const target = humanPeer(args[0]); return target ? target.peer.executeHumanTool(target.source.requestId,...args.slice(1)) : broker.executeHumanTool(...args); },
    completeHuman: async (...args: Parameters<typeof broker.completeHuman>) => {
      const target = humanPeer(args[0]);
      if (!target) return viewRequest(await broker.completeHuman(...args));
      await target.peer.completeHuman(target.source.requestId,...args.slice(1));
      const deadline = performance.now() + 5000;
      while (!terminal.has(polling.requestStatus(args[0]) ?? 'ERROR')) {
        if (performance.now() > deadline) throw codedError('The Human result is recorded; shared publication is still pending.', 'CACHE_BUSY');
        await delay(25);
      }
      return viewRequest(requestData(args[0]));
    },
    failRun: (...args: Parameters<typeof broker.failRun>) => viewRun(broker.failRun(...args)),
    cancel: (...args: Parameters<typeof broker.cancel>) => viewRun(broker.cancel(...args)),
  };
}

export type Broker<D extends ResultDetail = 'compact'> = ReturnType<typeof createBroker<D>>;
