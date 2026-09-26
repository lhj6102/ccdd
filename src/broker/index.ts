import { assertStateFormat, initializeStateFormat } from '../state-format.js';
import { semanticResult, validateFinalResult } from '../response-schema.js';
import { requesterRun, requesterRequest, resultView, type ResultDetail, type ResultOptions } from '../result-view.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareReviewRequests } from '../requester/index.js';
import { readWorkspaceConfig } from './config.js';
import { createGraphDefinition, type GraphDefinition } from './graph.js';
import { localAdmission, type Admission, type AdmissionLease } from './admission.js';
export type { Admission, AdmissionLease, AdmissionRequest } from './admission.js';
import { readChanges, type ChangeOptions } from './changes.js';
import { initializeRecords, records } from './storage.js';
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
import { createProjectSnapshot, DEFAULT_IDENTITY_CONCURRENCY, positiveConcurrency } from '../project/identity.js';
import { includedCritics, planProject } from '../project/query.js';
import { readEvidence, storedRequesterRun } from '../project/store.js';
import type { ProjectRunDefinition, ProjectSelection } from '../project/types.js';
import type { RunStatus } from '../contracts.js';
import type { ReviewEnvelope, ReviewRequest, ReviewResult, ReviewStatus, ReviewToolCall, ExecutionContext, ExecutorReadiness } from '../contracts.js';

/** Internal instrumentation for deterministic scheduler regression tests. */
export const brokerTestHooks: { onHydrate?: (bytes: number) => void; onPlan?: () => void; onIdleTick?: () => void } = {};
export interface RunRecord {
  id: string; repoId: string; snapshotHash: string; workspace: WorkspaceDescriptor;
  requesterId: string; scope?: { kind: 'graph' } | { kind: 'chain' } | { kind: 'critic'; criticId: string } | { kind: 'project' };
  project?: ProjectRunDefinition;
  graph?: GraphDefinition;
  status: RunStatus; coalescingGraceMs?: number; createdAt: string; completedAt?: string; error?: string;
}
export interface BrokerEvent { id: number; runId: string; requestId: string | null; createdAt: string; type: string; message: string; data?: unknown }
export interface RunView extends RunRecord { scope: NonNullable<RunRecord['scope']>; owner: { pid: number; claimedAt: string } | null; requests: ReviewRequest[]; events: BrokerEvent[] }
export interface BrokerExecutors {
  validateWorkspace?(repoPath: string): void | Promise<void>;
  canExecute(request: ReviewRequest): ExecutorReadiness | Promise<ExecutorReadiness>;
  execute(request: ReviewRequest, context: ExecutionContext & { signal: AbortSignal }): Promise<unknown>;
  notifyHuman?(request: ReviewRequest, context: { signal: AbortSignal }): Promise<unknown>;
}
export interface BrokerOptions { repoPath: string; stateDir: string; repoId?: string; coalescingGraceMs?: number; maxConcurrentExecutors?: number; admission?: Admission; identityConcurrency?: number; executors?: BrokerExecutors; workspaceIntegrity?: WorkspaceIntegrity; workspaceAdapter?: { prepareWorkspace: typeof prepareWorkspace; reopenWorkspace: typeof reopenWorkspace } }
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
export function createBroker<D extends ResultDetail = 'compact'>({ detail, repoPath, stateDir, repoId = 'demo', coalescingGraceMs = 15_000, maxConcurrentExecutors = 4, admission = localAdmission(maxConcurrentExecutors), identityConcurrency = DEFAULT_IDENTITY_CONCURRENCY, executors, workspaceIntegrity = 'content', workspaceAdapter = { prepareWorkspace, reopenWorkspace } }: BrokerOptions & ResultOptions<D>) {
  positiveConcurrency(maxConcurrentExecutors, 'maxConcurrentExecutors');
  positiveConcurrency(identityConcurrency, 'identityConcurrency');
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
    const previousRepo = db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = JSON.stringify({ repoPath, repoId });
    if (previousRepo && previousRepo.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
    db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('registered-repo', identity);
    // Recheck after INSERT OR IGNORE, since another process may initialize concurrently.
    if (db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo')?.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
  } catch (error) { db?.close(); throw error; }

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
    for (const key of ['status','startedAt','completedAt','claimedBy','claimedAt','tryClaim','preparationAttempt','claimAttemptId','notifiedAt','error','errorCode','blockedReason'] as const) {
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

  function finishWithin(requestId: string, outcome: { result?: ReviewResult; error?: unknown }, expectedStates: ReviewStatus[] = ['RUNNING', 'WAITING_HUMAN']) {
    const { result, error } = outcome, hasError = Object.hasOwn(outcome, 'error');
    const request = requestHeader(requestId);
    if (!request || !expectedStates.includes(request.status) || terminal.has(required(polling.runStatus(request.runId), 'Run'))) return false;
    request.status = hasError ? 'ERROR' : required(result, 'review result').verdict;
    request.resultRef = result ? store.put(result) : null;
    request.semanticRef = result ? store.put(semanticResult(result)) : null;
    request.error = hasError ? errorText(error) : null;
    request.errorCode = errorCode(error) ?? null;
    request.completedAt = now();
    saveHeader(request);
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
      request.status = 'ERROR'; request.resultRef = null; request.semanticRef = null; request.error = errorText(error); request.errorCode = errorCode(error) ?? null; request.completedAt = now(); request.blockedReason = null;
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

  async function executeOne(requestId: string, workspace: WorkspaceHandle, token: string, signal: AbortSignal) {
    const initial = required(requestHeader(requestId), 'Request');
    const runId = initial.runId;
    let lease: AdmissionLease | undefined;
    try {
      if (initial.profile.kind !== 'human') lease = await admission.acquire({ requestId, runId, kind: initial.profile.kind, provider: initial.profile.provider, model: initial.profile.model }, { signal, waiting(reason) {
        transaction(() => { const current = required(requestHeader(requestId), 'Request'); if (current.status !== 'QUEUED') return; current.blockedReason = reason.slice(0, 2000); saveHeader(current); }); changed();
      } });
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
          current.status = 'WAITING_HUMAN'; saveRequest(current);
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
      const result = validateResult(await requireExecutors().execute(copy(request), {
        worktreePath: workspace.descriptor.path, workspacePath: workspace.descriptor.path, runDir, signal,
        onEvent(event) {
          if (closed || closing || signal.aborted || !event || polling.requestStatus(requestId) !== 'RUNNING' || !['executor.started', 'artifact.tools.ready', 'artifact.tool.called', 'artifact.tool.completed', 'executor.usage', 'executor.final.invalid', 'executor.final.repair', 'executor.telemetry.failed', 'executor.completed'].includes(event.type)) return;
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
          appendEvent(runId, requestId, event.type, event.type === 'executor.telemetry.failed' ? 'Some optional execution diagnostics could not be recorded.' : String(event.message ?? event.type).slice(0, 2000), safe);
          changed();
        },
      }));
      validateFinalResult(semanticResult(result), request);
      await workspace.assertUnchanged();
      signal.throwIfAborted();
      transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { result }); });
      changed();
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      if (signal.aborted || fatalExecutionError(reason)) throw reason;
      transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { error: reason }); });
      changed();
    }
    } catch (error) { if (signal.aborted || fatalExecutionError(error)) throw error; transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { error }, ['QUEUED']); }); changed(); } finally { await lease?.release(); }
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
          const requests = db.prepare("SELECT id,status,json_extract(data,'$.profile.kind') AS kind FROM requests WHERE run_id=? AND status='QUEUED' ORDER BY ordinal LIMIT ?").all(runId, maxConcurrentExecutors + inFlight.size + 1) as unknown as { id: string; status: ReviewStatus; kind: ReviewRequest['profile']['kind'] }[];
          let executing = [...inFlight.values()].filter(item => item.kind !== 'human').length;
          for (const row of requests.filter(request => request.status === 'QUEUED' && !inFlight.has(request.id))) {
            const kind = row.kind;
            if (kind !== 'human' && executing >= maxConcurrentExecutors) continue;
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
      return { ...copy(required(runData(runId), 'Run')), requests: runRequests(runId) };
    })();
    return entry.promise;
  }

  const broker = {
    async submitProject({ requesterId = 'cli', selection, recursive = false, force = false, ignoreGates = false, signal, identityConcurrency: submissionIdentityConcurrency = identityConcurrency, ...removed }: { requesterId?: string; selection: ProjectSelection; recursive?: boolean; force?: boolean; ignoreGates?: boolean; signal?: AbortSignal; identityConcurrency?: number }) {
      ensureOpen(); requireExecutors(); sweepSubmissionDeadlines();
      positiveConcurrency(submissionIdentityConcurrency, 'identityConcurrency');
      if ('mode' in removed) throw new Error('Workspace modes are no longer supported; supply an unchanged workspace.');
      if (!requesterId.trim() || requesterId.length > 200) throw new Error('requesterId is required (maximum 200 characters).');
      await requireExecutors().validateWorkspace?.(repoPath);
      const workspace = await workspaceAdapter.prepareWorkspace({ repoPath, stateDir, integrity: workspaceIntegrity, signal });
      try {
        const { config } = await readWorkspaceConfig(workspace.descriptor.path, workspace.signal);
        const snapshot = await createProjectSnapshot(config, workspace.descriptor.path, workspace.descriptor.hash, workspace.signal, workspace.descriptor.integrity, selection, { identityConcurrency: submissionIdentityConcurrency });
        const ids = includedCritics(snapshot, selection, recursive);
        const templates: ReviewEnvelope[] = [];
        for (const id of ids) templates.push(...await prepareReviewRequests({ repoPath: workspace.descriptor.path, repoId, snapshotHash: workspace.descriptor.hash, criticId: id, preparedConfig: config }));
        const id = randomUUID(), createdAt = now();
        const record: RunRecord = { id, repoId, coalescingGraceMs, snapshotHash: workspace.descriptor.hash, workspace: workspace.descriptor, requesterId,
          scope: { kind: 'project' }, graph: createGraphDefinition(config), project: { version: 3, snapshot, selection, recursive, force, ignoreGates, templates }, status: 'QUEUED', createdAt };
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted();
        transaction(() => {
          db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?)').run(id, createdAt, record.status, JSON.stringify(store.packRun(record)));
          appendEvent(id, null, 'run.submitted', 'Project validation requested against fixed input.', { selection, recursive, force });
          brokerTestHooks.onPlan?.(); readiness.initialize(record);
        });
        changed(); return required(getRun(id), 'Run');
      } finally { await workspace.close(); }
    },
    run,
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
        request.status = Number(gate?.unmet ?? 0) ? Number(gate?.red ?? 0) ? 'BLOCKED' : 'WAIT_DEPENDENCY' : 'QUEUED'; request.error = null; request.errorCode = null; request.resultRef = null; request.semanticRef = null; request.startedAt = null; request.completedAt = null;
        saveHeader(request);
        appendEvent(run.id, request.id, 'request.retried', 'Retry requested against the same immutable input.');
      });
      changed(); return viewRequest(requestData(requestId));
    },
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
      clearReadCaches(); submissionDeadlines.clear(); listeners.clear(); db.close(); closed = true;
    },
  };
  const viewRun = <T extends Parameters<typeof requesterRun>[0] | null>(value: T) => resultView({ detail }, value, () => value ? storedRequesterRun(db, value.id, stateDir) ?? requesterRun(value, stateDir) : null);
  const viewRequest = (value: ReviewRequest | null) => resultView({ detail }, value, () => value ? requesterRequest(value, stateDir) : null);
  return {
    ...broker,
    submitProject: async (...args: Parameters<typeof broker.submitProject>) => viewRun(await broker.submitProject(...args))!,
    run: async (...args: Parameters<typeof broker.run>) => viewRun(await broker.run(...args)),
    getRun: (id: string) => { ensureOpen(); if (ownerData(id)) reconcile(id); return resultView({ detail }, detail === 'full' ? broker.getRun(id) : null, () => storedRequesterRun(db, id, stateDir)); },
    listRuns: () => { ensureOpen(); return db.prepare('SELECT id FROM runs ORDER BY created_at DESC,rowid DESC').all().map(row => { const id = String(row.id); return resultView({ detail }, detail === 'full' ? required(broker.getRun(id), 'Run') : null!, () => required(storedRequesterRun(db, id, stateDir), 'Run')); }); },
    getRequest: (id: string) => viewRequest(broker.getRequest(id)),
    claimHuman: async (...args: Parameters<typeof broker.claimHuman>) => viewRequest(await broker.claimHuman(...args))!,
    completeHuman: async (...args: Parameters<typeof broker.completeHuman>) => viewRequest(await broker.completeHuman(...args)),
    failRun: (...args: Parameters<typeof broker.failRun>) => viewRun(broker.failRun(...args)),
    cancel: (...args: Parameters<typeof broker.cancel>) => viewRun(broker.cancel(...args)),
  };
}

export type Broker<D extends ResultDetail = 'compact'> = ReturnType<typeof createBroker<D>>;
