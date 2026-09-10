import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareReviewRequests, readStoredArtifactScope } from '../requester/index.js';
import { readWorkspaceConfig } from './config.js';
import { createGraphDefinition, prerequisiteCriticIds, type GraphDefinition } from './graph.js';
import { createReviewTools } from '../tools/runner.js';
import { prepareWorkspace, reopenWorkspace, type WorkspaceDescriptor, type WorkspaceHandle, type WorkspaceMode } from '../workspaces/index.js';
import { createProjectSnapshot } from '../project/identity.js';
import { includedCritics, planProject } from '../project/query.js';
import { readEvidence } from '../project/store.js';
import type { ProjectRunDefinition, ProjectSelection } from '../project/types.js';
import type { RunStatus } from '../contracts.js';
import type { ReviewEnvelope, ReviewRequest, ReviewResult, ReviewStatus, ReviewToolCall, ExecutionContext, ExecutorReadiness } from '../contracts.js';

interface OwnerRecord { run_id: string; pid: number; process_identity: string | null; token: string; claimed_at: string }
export interface RunRecord {
  id: string; repoId: string; snapshotHash: string; workspace: WorkspaceDescriptor;
  requesterId: string; scope?: { kind: 'graph' } | { kind: 'chain' } | { kind: 'critic'; criticId: string } | { kind: 'project' };
  project?: ProjectRunDefinition;
  graph?: GraphDefinition;
  status: RunStatus; createdAt: string; completedAt?: string; error?: string;
}
export interface BrokerEvent { id: number; runId: string; requestId: string | null; createdAt: string; type: string; message: string; data?: unknown }
export interface RunView extends RunRecord { scope: NonNullable<RunRecord['scope']>; owner: { pid: number; claimedAt: string } | null; requests: ReviewRequest[]; events: BrokerEvent[] }
export interface BrokerExecutors {
  validateWorkspace?(repoPath: string): void | Promise<void>;
  canExecute(request: ReviewRequest): ExecutorReadiness | Promise<ExecutorReadiness>;
  execute(request: ReviewRequest, context: ExecutionContext & { signal: AbortSignal }): Promise<unknown>;
  notifyHuman?(request: ReviewRequest, context: { signal: AbortSignal }): Promise<unknown>;
}
export interface BrokerOptions { repoPath: string; stateDir: string; repoId?: string; executors?: BrokerExecutors; workspaceAdapter?: { prepareWorkspace: typeof prepareWorkspace; reopenWorkspace: typeof reopenWorkspace } }
interface ActiveRun { runId: string; token: string; abort: AbortController; promise: Promise<RunRecord & { requests: ReviewRequest[] }> | null }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorCode = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined;
const parseStored = <T>(value: unknown): T => { if (typeof value !== 'string') throw new Error('Broker store contains a non-text JSON record.'); return JSON.parse(value) as T; };
const required = <T>(value: T | null | undefined, label: string): T => { if (value == null) throw new Error(`Unknown ${label}.`); return value; };


const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const now = () => new Date().toISOString();
const errorText = (error: unknown) => String(object(error) && typeof error.message === 'string' ? error.message : error).slice(0, 2000);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const codedError = (message: string, code: string) => Object.assign(new Error(message), { code });
const MAX_CONCURRENT_EXECUTORS = 4;
const fatalExecutionError = (error: unknown): boolean => {
  const code = errorCode(error);
  return Boolean(code?.startsWith('WORKSPACE_') || ['RUN_OWNERSHIP_LOST', 'REVIEW_CANCELED', 'WORKER_STOPPED', 'WORKER_EXITED', 'REVIEW_GRAPH_INVALID'].includes(code ?? ''));
};

function storedObservation(value: unknown): ReviewToolCall['observation'] {
  if (!object(value) || typeof value.artifactId !== 'string' || typeof value.operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.operation)) return undefined;
  const observation: NonNullable<ReviewToolCall['observation']> = { artifactId: value.artifactId.slice(0, 64), operation: value.operation };
  if (value.kind === 'content' || value.kind === 'empty') observation.kind = value.kind;
  if (typeof value.detail === 'string') observation.detail = value.detail.slice(0, 2000);
  for (const key of ['startLine', 'endLine', 'lineCount', 'totalLines'] as const) {
    const number = value[key];
    if (number === null || (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)) observation[key] = number;
  }
  return observation;
}

function validateResult(value: unknown): ReviewResult {
  if (!object(value) || (value.verdict !== 'GREEN' && value.verdict !== 'RED') || typeof value.summary !== 'string' || !value.summary.trim() ||
      !Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string')) {
    throw new Error('Review result requires GREEN/RED verdict, a summary, and string evidence[].');
  }
  const result: ReviewResult = { verdict: value.verdict, summary: value.summary.slice(0, 12_000), evidence: (value.evidence as string[]).slice(0, 100).map(item => item.slice(0, 4000)) };
  for (const key of ['provider', 'model', 'stdout', 'stderr'] as const) { const field = value[key]; if (typeof field === 'string') result[key] = field.slice(0, 24_000); }
  for (const key of ['durationMs', 'exitCode'] as const) { const field = value[key]; if (typeof field === 'number' && Number.isFinite(field)) result[key] = field; }
  if (Array.isArray(value.toolCalls)) result.toolCalls = value.toolCalls.slice(0, 100).filter((item): item is Record<string, unknown> & { name: string } => object(item) && typeof item.name === 'string').map(item => {
    const call: ReviewToolCall = { name: item.name, ...(item.arguments === undefined ? {} : { arguments: copy(item.arguments) }) };
    const observation = storedObservation(item.observation);
    if (observation) call.observation = observation;
    return call;
  });
  if (JSON.stringify(result).length > 256_000) throw new Error('Review result exceeds the supported size.');
  return result;
}

function processIdentity(pid: number) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    return `ps:${execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`;
  } catch { return null; }
}
const ownProcessIdentity = processIdentity(process.pid);

function ownerAlive(owner: OwnerRecord | undefined) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { if (errorCode(error) === 'ESRCH') return false; }
  const identity = owner.pid === process.pid ? ownProcessIdentity : processIdentity(owner.pid);
  return !owner.process_identity || !identity || owner.process_identity === identity;
}

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
    throw codedError('CCDD state, logs and copied workspaces must be outside the reviewed repository.', 'WORKSPACE_UNSAFE');
  }
  fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  return fs.realpathSync(canonical);
}

/** Durable broker operations. Merely opening the store never starts a worker. */
export function createBroker({ repoPath, stateDir, repoId = 'demo', executors, workspaceAdapter = { prepareWorkspace, reopenWorkspace } }: BrokerOptions) {
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
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_run ON requests(run_id, ordinal);
      CREATE INDEX IF NOT EXISTS requests_validation_input ON requests(json_extract(data, '$.validationInput.key'));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), request_id TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_owners (run_id TEXT PRIMARY KEY REFERENCES runs(id), pid INTEGER NOT NULL, process_identity TEXT, token TEXT NOT NULL, claimed_at TEXT NOT NULL);`);
    const previousRepo = db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = JSON.stringify({ repoPath, repoId });
    if (previousRepo && previousRepo.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
    db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('registered-repo', identity);
    // Recheck after INSERT OR IGNORE, since another process may initialize concurrently.
    if (db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo')?.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
  } catch (error) { db?.close(); throw error; }

  let closed = false;
  let closing = false;
  const active = new Map<string, ActiveRun>();
  const listeners = new Set<() => void>();
  const ensureOpen = () => { if (closed || closing) throw new Error('Broker is closed.'); };
  const requireExecutors = () => {
    if (!executors || typeof executors.canExecute !== 'function' || typeof executors.execute !== 'function') throw new Error('Review submission and execution require an executor registry.');
    return executors;
  };
  const transaction = <T>(callback: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const requestData = (id: string): ReviewRequest | null => {
    const row = db.prepare('SELECT data FROM requests WHERE id = ?').get(id);
    return row ? parseStored<ReviewRequest>(row.data) : null;
  };
  const runData = (id: string): RunRecord | null => {
    const row = db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    return row ? parseStored<RunRecord>(row.data) : null;
  };
  const ownerData = (id: string): OwnerRecord | undefined => db.prepare('SELECT * FROM run_owners WHERE run_id = ?').get(id) as OwnerRecord | undefined;
  const runRequests = (id: string): ReviewRequest[] => db.prepare('SELECT data FROM requests WHERE run_id = ? ORDER BY ordinal').all(id).map(row => parseStored<ReviewRequest>(row.data));
  const saveRequest = (request: ReviewRequest) => db.prepare('UPDATE requests SET status = ?, data = ? WHERE id = ?').run(request.status, JSON.stringify(request), request.id);
  const saveRun = (run: RunRecord) => db.prepare('UPDATE runs SET status = ?, data = ? WHERE id = ?').run(run.status, JSON.stringify(run), run.id);
  const appendEvent = (runId: string, requestId: string | null, type: string, message: string, data: unknown = null) => {
    db.prepare('INSERT INTO events(run_id,request_id,created_at,type,message,data) VALUES (?,?,?,?,?,?)').run(runId, requestId, now(), type, message.slice(0, 4000), data === null ? null : JSON.stringify(data));
  };
  const changed = () => { for (const callback of listeners) { try { callback(); } catch {} } };
  function prerequisites(request: ReviewRequest, run: RunRecord, requests: ReviewRequest[]): ReviewRequest[] {
    if (run.project) return []; // Project requests are issued only after a pull readiness check.
    if (run.scope?.kind === 'critic') return [];
    if (run.graph) {
      const byCritic = new Map(requests.map(item => [item.criticId, item]));
      return prerequisiteCriticIds(request, run.graph).map(id => {
        const dependency = byCritic.get(id);
        if (!dependency || dependency.runId !== run.id) throw codedError(`Required Critic ${id} is missing from this Run.`, 'REVIEW_GRAPH_INVALID');
        return dependency;
      });
    }
    // Historical chains retain their explicit links; no target Artifact is guessed.
    if (request.predecessorId === null || (request.predecessorId === undefined && requests.length === 1)) return [];
    const previous = requests.find(item => item.id === request.predecessorId);
    if (!previous || previous.runId !== run.id) throw codedError('This historical Run has no usable predecessor link. Submit a new review.', 'REVIEW_GRAPH_INVALID');
    return [previous];
  }
  function dependencyFailure(request: ReviewRequest, run: RunRecord, requests: ReviewRequest[], seen = new Set<string>()): ReviewRequest | null {
    if (seen.has(request.id)) return null;
    seen.add(request.id);
    for (const dependency of prerequisites(request, run, requests)) {
      if (dependency.status === 'RED' || dependency.status === 'ERROR') return dependency;
      const failure = dependencyFailure(dependency, run, requests, seen);
      if (failure) return failure;
    }
    return null;
  }
  function refreshReadinessWithin(runId: string): void {
    const run = required(runData(runId), 'Run'), requests = runRequests(runId);
    if (run.project) {
      if (terminal.has(run.status)) return;
      const plan = planProject(run.project.snapshot, readEvidence(db), { selection: run.project.selection, recursive: run.project.recursive, force: run.project.force, runId, attempts: requests });
      for (const item of plan.items.filter(item => item.action === 'EXECUTE')) {
        const envelope = run.project.templates.find(template => template.criticId === item.id);
        if (!envelope) throw codedError(`Missing prepared Critic ${item.id}.`, 'REVIEW_GRAPH_INVALID');
        const request: ReviewRequest = { ...copy(envelope), validationInput: copy(item.input), id: randomUUID(), runId,
          workspace: run.workspace, worktreePath: run.workspace.path, status: 'QUEUED', createdAt: now(),
          startedAt: null, completedAt: null, claimedBy: null, claimedAt: null, notifiedAt: null, result: null, error: null, blockedReason: null };
        db.prepare('INSERT INTO requests(id,run_id,ordinal,status,data) VALUES (?,?,?,?,?)').run(request.id, runId, requests.length, request.status, JSON.stringify(request));
        requests.push(request);
        appendEvent(runId, request.id, 'request.queued', 'Pull validation found an executable Critic requiring an actual review.');
      }
      return;
    }
    for (const request of requests) {
      if (request.status !== 'BLOCKED') continue;
      const dependencies = prerequisites(request, run, requests);
      if (dependencies.every(item => item.status === 'GREEN')) {
        request.status = 'QUEUED'; request.blockedReason = null; saveRequest(request);
        appendEvent(runId, request.id, 'request.queued', 'All required Artifact reviews are GREEN.');
      } else {
        const failed = dependencyFailure(request, run, requests);
        const reason = failed ? `${failed.criticId} returned ${failed.status}; dependent reviews cannot start.` : `Waiting for ${dependencies.filter(item => item.status !== 'GREEN').map(item => item.criticId).join(', ')} to become GREEN.`;
        if (request.blockedReason !== reason) { request.blockedReason = reason; saveRequest(request); }
      }
    }
  }
  const updateRunStatus = (runId: string) => {
    const states = runRequests(runId).map(request => request.status);
    const run = required(runData(runId), 'Run');
    if (run.project) {
      if (terminal.has(run.status)) return;
      const plan = planProject(run.project.snapshot, readEvidence(db), { selection: run.project.selection, recursive: run.project.recursive, force: run.project.force, runId, attempts: runRequests(runId) });
      const status: RunStatus = states.includes('RUNNING') ? 'RUNNING' : states.includes('QUEUED') ? 'QUEUED' : states.includes('WAITING_HUMAN') ? 'WAITING_HUMAN' :
        states.includes('ERROR') ? 'ERROR' : states.includes('RED') ? 'RED' : plan.satisfied ? 'GREEN' : 'INCOMPLETE';
      if (run.status !== status) {
        run.status = status;
        if (terminal.has(status)) {
          run.completedAt = now();
          run.project.evidenceRequestIds = [...new Set(plan.critics.flatMap(c => c.result ? [c.result.requestId] : []))];
        }
        saveRun(run); appendEvent(runId, null, 'run.status', `Run ${status}`, { status });
      }
      return;
    }
    // A branch failure is a verdict for that branch, not a stop signal for its siblings.
    const status = states.includes('RUNNING') ? 'RUNNING' : states.includes('QUEUED') ? 'QUEUED' :
      states.includes('WAITING_HUMAN') ? 'WAITING_HUMAN' : states.includes('ERROR') ? 'ERROR' : states.includes('RED') ? 'RED' :
      states.length > 0 && states.every(state => state === 'GREEN') ? 'GREEN' : 'ERROR';
    if (run.status !== status) {
      run.status = status;
      if (terminal.has(status)) run.completedAt = now();
      else delete run.completedAt;
      saveRun(run);
      appendEvent(runId, null, 'run.status', `Run ${status}`, { status });
    }
  };

  function finishWithin(requestId: string, outcome: { result?: ReviewResult; error?: unknown }, expectedStates: ReviewStatus[] = ['RUNNING', 'WAITING_HUMAN']) {
    const { result, error } = outcome, hasError = Object.hasOwn(outcome, 'error');
    const request = requestData(requestId);
    if (!request || !expectedStates.includes(request.status) || terminal.has(required(runData(request.runId), 'Run').status)) return false;
    request.status = hasError ? 'ERROR' : required(result, 'review result').verdict;
    request.result = result ?? null;
    request.error = hasError ? errorText(error) : null;
    request.errorCode = errorCode(error) ?? null;
    request.completedAt = now();
    saveRequest(request);
    appendEvent(request.runId, request.id, hasError ? 'request.error' : 'request.completed', hasError ? required(request.error, 'error message') : required(result, 'review result').summary, { status: request.status, ...(request.errorCode ? { code: request.errorCode } : {}) });
    refreshReadinessWithin(request.runId);
    updateRunStatus(request.runId);
    return true;
  }

  function failWithin(runId: string, error: unknown) {
    const run = runData(runId);
    if (!run || terminal.has(run.status)) return;
    for (const request of runRequests(runId)) {
      if (terminal.has(request.status)) continue;
      request.status = 'ERROR'; request.result = null; request.error = errorText(error); request.errorCode = errorCode(error) ?? null;
      request.completedAt = now(); request.blockedReason = null; saveRequest(request);
      appendEvent(runId, request.id, 'request.error', request.error, { status: request.status, ...(request.errorCode ? { code: request.errorCode } : {}) });
    }
    if (run.project) {
      const plan = planProject(run.project.snapshot, readEvidence(db), { selection: run.project.selection, recursive: run.project.recursive, force: run.project.force, runId, attempts: runRequests(runId) });
      run.project.evidenceRequestIds = [...new Set(plan.critics.flatMap(c => c.result ? [c.result.requestId] : []))];
    }
    run.status = 'ERROR'; run.error = errorText(error); run.completedAt = now(); saveRun(run);
    appendEvent(runId, null, 'run.error', run.error);
  }

  function reconcileWithin(runId: string) {
    const owner = ownerData(runId);
    if (!owner || ownerAlive(owner)) return;
    const run = runData(runId);
    const unfinished = runRequests(runId).filter(request => !terminal.has(request.status));
    const safeHumanWait = run?.workspace?.mode === 'copy' && unfinished.some(request => request.status === 'WAITING_HUMAN') &&
      unfinished.every(request => request.status === 'BLOCKED' || (request.status === 'WAITING_HUMAN' && request.notifiedAt));
    if (!safeHumanWait) {
      failWithin(runId, codedError('The review worker exited before completing its work. Submit a new run to retry.', 'WORKER_EXITED'));
    }
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
    if (!runData(id)) return null;
    if (ownerData(id)) reconcile(id);
    const run = required(runData(id), 'Run');
    const owner = ownerData(id);
    const events = db.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: Number(event.id), runId: String(event.run_id), requestId: event.request_id === null ? null : String(event.request_id), createdAt: String(event.created_at), type: String(event.type), message: String(event.message), ...(event.data ? { data: parseStored<unknown>(event.data) } : {}) }));
    return { ...run, scope: run.scope ?? { kind: run.graph ? 'graph' : 'chain' }, owner: owner ? { pid: owner.pid, claimedAt: owner.claimed_at } : null, requests: runRequests(id), events };
  }

  function failOwned(runId: string, token: string, error: unknown) {
    transaction(() => { if (ownerData(runId)?.token === token) failWithin(runId, error); });
    changed();
  }

  async function executeOne(requestId: string, workspace: WorkspaceHandle, token: string, signal: AbortSignal) {
    const initial = required(requestData(requestId), 'Request');
    const runId = initial.runId;
    transaction(() => {
      const request = required(requestData(requestId), 'Request');
      if (ownerData(runId)?.token !== token || request.status !== 'QUEUED') throw codedError('Review ownership changed before execution.', 'RUN_OWNERSHIP_LOST');
      request.status = 'RUNNING'; request.startedAt = now(); request.blockedReason = null; saveRequest(request);
      appendEvent(runId, request.id, 'request.started', `${request.title}: reviewing ${workspace.descriptor.mode} workspace.`, { snapshotHash: workspace.descriptor.hash });
      updateRunStatus(runId);
    });
    changed();
    try {
      signal.throwIfAborted();
      await workspace.assertUnchanged();
      const request = required(requestData(requestId), 'Request');
      const runDir = path.join(stateDir, 'runs', runId, request.id);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      if (required(runData(runId), 'Run').project) {
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
          if (closed || closing || signal.aborted || !event || requestData(requestId)?.status !== 'RUNNING' || !['executor.started', 'artifact.tools.ready', 'artifact.tool.called', 'executor.completed'].includes(event.type)) return;
          const safe: Record<string, unknown> = {};
          for (const key of ['name', 'provider', 'model', 'kind', 'artifactId', 'path']) if (typeof event[key] === 'string') safe[key] = (event[key] as string).slice(0, 1000);
          if (object(event.observation)) {
            // Persist the same bounded metadata as final results, even if the Provider later fails.
            const observed = storedObservation(event.observation);
            if (observed) safe.observation = observed;
          }
          if (Array.isArray(event.tools)) safe.tools = event.tools.slice(0, 32).map(tool => typeof tool === 'string' ? tool : tool?.name).filter(value => typeof value === 'string');
          appendEvent(runId, requestId, event.type, String(event.message ?? event.type).slice(0, 2000), safe);
          changed();
        },
      }));
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
  }

  async function run(runId: string, { signal, onStarted }: { signal?: AbortSignal; onStarted?: (value: { runId: string; pid: number }) => void } = {}) {
    ensureOpen(); requireExecutors();
    const token = randomUUID();
    let stored: RunRecord | null = null;
    const acquired = transaction(() => {
      reconcileWithin(runId);
      stored = runData(runId);
      if (!stored) throw new Error('Unknown Run.');
      if (terminal.has(stored.status)) return false;
      if (!stored.workspace) throw new Error('This legacy Run has no workspace descriptor; submit a new review.');
      if (ownerData(runId)) throw codedError('Another process already owns this review Run.', 'RUN_ALREADY_OWNED');
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
      try {
        onStarted?.({ runId, pid: process.pid });
        workspace = await workspaceAdapter.reopenWorkspace(ownedRun.workspace, { signal: executionSignal });
        const reviewSignal = AbortSignal.any([executionSignal, workspace.signal]);
        poll = setInterval(() => {
          if (ownerData(runId)?.token !== token) abort.abort(codedError('Review ownership was lost.', 'RUN_OWNERSHIP_LOST'));
          else if (terminal.has(required(runData(runId), 'Run').status)) abort.abort(codedError('Review is already complete or canceled.', 'REVIEW_CANCELED'));
        }, 100);
        while (true) {
          const current = required(runData(runId), 'Run');
          if (terminal.has(current.status)) {
            if (inFlight.size) abort.abort(codedError('Review is already complete or canceled.', 'REVIEW_CANCELED'));
            break;
          }
          reviewSignal.throwIfAborted();
          transaction(() => { refreshReadinessWithin(runId); updateRunStatus(runId); });
          const requests = runRequests(runId);
          let executing = [...inFlight.values()].filter(item => item.kind !== 'human').length;
          for (const queued of requests.filter(request => request.status === 'QUEUED')) {
            if (queued.profile.kind !== 'human' && executing >= MAX_CONCURRENT_EXECUTORS) continue;
            if (queued.profile.kind !== 'human') executing++;
            const promise = executeOne(queued.id, workspace, token, reviewSignal).catch(error => {
              // A different task may win Promise.race before this rejection. Preserve fatal failure independently of that race.
              abort.abort(error);
              throw error;
            }).finally(() => { inFlight.delete(queued.id); });
            inFlight.set(queued.id, { kind: queued.profile.kind, promise });
          }
          if (inFlight.size) {
            // Human alarms and independent branches progress together; completed dependencies can unblock work immediately.
            await Promise.race([...inFlight.values()].map(item => item.promise).concat(delay(50, undefined, { signal: reviewSignal })));
            continue;
          }
          const waiting = requests.filter(request => request.status === 'WAITING_HUMAN');
          if (waiting.length) {
            if (waiting.some(request => !request.notifiedAt)) throw new Error('Human notification did not complete; submit a new Run to retry.');
            await workspace.assertUnchanged();
            if (ownedRun.workspace.mode === 'copy') {
              // A result can arrive during input validation. Release only after rechecking all branches atomically.
              const paused = transaction(() => {
                const pending = runRequests(runId).filter(request => !terminal.has(request.status));
                if (!pending.some(request => request.status === 'WAITING_HUMAN') || pending.some(request => request.status !== 'BLOCKED' && (request.status !== 'WAITING_HUMAN' || !request.notifiedAt))) return false;
                if (ownerData(runId)?.token !== token) throw codedError('Review ownership was lost.', 'RUN_OWNERSHIP_LOST');
                db.prepare('DELETE FROM run_owners WHERE run_id = ? AND token = ?').run(runId, token);
                appendEvent(runId, null, 'worker.paused', 'Copied Human reviews are persisted; no worker is needed while awaiting results.');
                return true;
              });
              if (paused) break;
              continue;
            }
            await delay(100, undefined, { signal: reviewSignal });
            continue;
          }
          if (terminal.has(required(runData(runId), 'Run').status)) break;
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
      return { ...required(runData(runId), 'Run'), requests: runRequests(runId) };
    })();
    return entry.promise;
  }

  return {
    async submitProject({ mode = 'copy', requesterId = 'cli', selection, recursive = false, force = false }: { mode?: WorkspaceMode; requesterId?: string; selection: ProjectSelection; recursive?: boolean; force?: boolean }) {
      ensureOpen(); requireExecutors();
      if (!requesterId.trim() || requesterId.length > 200) throw new Error('requesterId is required (maximum 200 characters).');
      if (!['lock', 'copy'].includes(mode)) throw new Error('mode must be lock or copy.');
      await requireExecutors().validateWorkspace?.(repoPath);
      const workspace = await workspaceAdapter.prepareWorkspace({ repoPath, stateDir, mode });
      try {
        const { config } = await readWorkspaceConfig(workspace.descriptor.path);
        const snapshot = await createProjectSnapshot(config, workspace.descriptor.path, workspace.descriptor.hash, workspace.signal);
        const ids = includedCritics(snapshot, selection, recursive);
        const templates: ReviewEnvelope[] = [];
        for (const id of ids) templates.push(...await prepareReviewRequests({ repoPath: workspace.descriptor.path, repoId, snapshotHash: workspace.descriptor.hash, criticId: id, preparedConfig: config }));
        const id = randomUUID(), createdAt = now();
        const record: RunRecord = { id, repoId, snapshotHash: workspace.descriptor.hash, workspace: workspace.descriptor, requesterId,
          scope: { kind: 'project' }, graph: createGraphDefinition(config), project: { version: 1, snapshot, selection, recursive, force, templates }, status: 'QUEUED', createdAt };
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted();
        transaction(() => {
          db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?)').run(id, createdAt, record.status, JSON.stringify(record));
          appendEvent(id, null, 'run.submitted', 'Project validation requested against fixed input.', { selection, recursive, force });
          refreshReadinessWithin(id); updateRunStatus(id);
        });
        changed(); return required(getRun(id), 'Run');
      } finally { await workspace.close(); }
    },
    async submit({ mode = 'copy', requesterId, reviewRequests, criticId, snapshotCommit }: { mode?: WorkspaceMode; requesterId?: unknown; reviewRequests?: unknown; criticId?: unknown; snapshotCommit?: unknown } = {}) {
      ensureOpen(); requireExecutors();
      if (snapshotCommit !== undefined) throw new Error('snapshotCommit is no longer accepted; use mode copy or lock with the current workspace.');
      if (typeof requesterId !== 'string' || !requesterId.trim() || requesterId.length > 200) throw new Error('requesterId is required (maximum 200 characters).');
      if (!['lock', 'copy'].includes(mode)) throw new Error('mode must be lock or copy.');
      await requireExecutors().validateWorkspace?.(repoPath);
      const workspace = await workspaceAdapter.prepareWorkspace({ repoPath, stateDir, mode });
      try {
        const descriptor = copy(workspace.descriptor);
        const { config } = await readWorkspaceConfig(descriptor.path);
        const graph = createGraphDefinition(config);
        const expected = await prepareReviewRequests({ repoPath: descriptor.path, repoId, snapshotHash: descriptor.hash, criticId, preparedConfig: config });
        const supplied = reviewRequests === undefined ? expected : reviewRequests;
        if (!isDeepStrictEqual(supplied, expected)) throw new Error('Submitted review request envelopes must exactly match the Artifact definitions, payload, profiles and dependencies in the requested workspace.');
        const id = randomUUID();
        const createdAt = now();
        const requests: ReviewRequest[] = copy(supplied as ReviewEnvelope[]).map(envelope => ({
          ...envelope, id: randomUUID(), runId: id, workspace: descriptor, worktreePath: descriptor.path,
          status: 'BLOCKED', createdAt, startedAt: null, completedAt: null,
          result: null, error: null, claimedBy: null, claimedAt: null, notifiedAt: null,
        }));
        for (const request of requests) {
          const dependencies = criticId === undefined ? prerequisiteCriticIds(request, graph) : [];
          request.status = dependencies.length ? 'BLOCKED' : 'QUEUED';
          request.blockedReason = dependencies.length ? `Waiting for ${dependencies.join(', ')} to become GREEN.` : null;
          const capability = await requireExecutors().canExecute(copy(request));
          if (!capability?.ok) throw new Error(`Cannot execute ${request.criticId}: ${capability?.reason ?? 'No compatible executor.'}`);
          if (request.profile.kind === 'human' && typeof requireExecutors().notifyHuman !== 'function') throw new Error('Human execution requires an alarm method.');
        }
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted(); ensureOpen();
        const scope: NonNullable<RunRecord['scope']> = criticId === undefined ? { kind: 'graph' } : { kind: 'critic', criticId: criticId as string };
        const record: RunRecord = { id, repoId, snapshotHash: descriptor.hash, workspace: descriptor, requesterId, scope, graph, status: 'QUEUED', createdAt };
        transaction(() => {
          db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?)').run(id, createdAt, record.status, JSON.stringify(record));
          requests.forEach((request, index) => db.prepare('INSERT INTO requests(id,run_id,ordinal,status,data) VALUES (?,?,?,?,?)').run(request.id, id, index, request.status, JSON.stringify(request)));
          appendEvent(id, null, 'run.submitted', 'Review persisted; a request-scoped worker can execute it.', { snapshotHash: descriptor.hash, mode, requesterId, scope });
          for (const request of requests) if (request.status === 'QUEUED') appendEvent(id, request.id, 'request.queued', 'Required Artifact reviews are satisfied; the review is ready.');
          appendEvent(id, null, 'workspace.ready', mode === 'copy' ? 'Content-addressed copied workspace is ready.' : 'Current workspace is fixed for this review; changes invalidate it.', { path: descriptor.path, snapshotHash: descriptor.hash });
        });
        changed();
        return required(getRun(id), 'Run');
      } finally { await workspace.close(); }
    },
    run,
    reconcile,
    listRuns() {
      ensureOpen();
      return db.prepare('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC').all().map(row => {
        const record = required(getRun(String(row.id)), 'Run');
        return { ...record, events: undefined, requests: record.requests.map(({ result, ...request }) => ({ ...request, result: result ? { verdict: result.verdict, summary: result.summary } : null })) };
      });
    },
    getRun,
    getRequest(id: string) {
      ensureOpen();
      const request = requestData(id);
      if (request) reconcile(request.runId);
      return requestData(id);
    },
    claimHuman(requestId: string, reviewerId: unknown) {
      ensureOpen();
      if (typeof reviewerId !== 'string' || !reviewerId.trim() || reviewerId.length > 200) throw new Error('A reviewerId is required.');
      const existing = requestData(requestId);
      if (existing) reconcile(existing.runId);
      transaction(() => {
        const request = requestData(requestId);
        if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
        if (request.claimedBy && request.claimedBy !== reviewerId) throw new Error('This review is already claimed by another reviewer.');
        if (!request.claimedBy) {
          request.claimedBy = reviewerId; request.claimedAt = now(); saveRequest(request);
          appendEvent(request.runId, request.id, 'human.claimed', `Review claimed by ${reviewerId}.`);
        }
      });
      changed(); return requestData(requestId);
    },
    async executeHumanTool(requestId: string, { reviewerId, toolName, arguments: args = {}, signal }: { reviewerId: unknown; toolName: string; arguments?: unknown; signal?: AbortSignal }) {
      ensureOpen();
      const first = requestData(requestId);
      if (first) reconcile(first.runId);
      const assertClaim = () => {
        ensureOpen();
        const current = requestData(requestId);
        if (!current || current.profile.kind !== 'human' || current.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
        if (!reviewerId || current.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can use its tools.');
        if (current.workspace.mode === 'lock' && !ownerAlive(ownerData(current.runId))) throw new Error('A lock review requires its monitoring worker to remain alive.');
        return current;
      };
      const request = assertClaim();
      let workspace: WorkspaceHandle | undefined;
      let inputsValidated = false;
      try {
        workspace = await workspaceAdapter.reopenWorkspace(request.workspace, { signal });
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted();
        inputsValidated = true;
        if (!request.configManifest) {
          if (Object.values(request.artifactTypes).some(type => type.custom)) throw codedError('Stored TS Artifact configuration has no tool manifest.', 'WORKSPACE_ARTIFACT_MISMATCH');
          const expected = await readStoredArtifactScope({ repoPath: workspace.descriptor.path, criticId: request.criticId });
          if (!expected || expected.profile.kind !== 'human' || !isDeepStrictEqual(expected.artifactTypes, request.artifactTypes) || !isDeepStrictEqual(expected.artifacts, request.artifacts) || !isDeepStrictEqual(expected.artifactGroups ?? [], request.artifactGroups ?? [])) {
            throw codedError('Stored Artifact tools do not match the reviewed workspace configuration.', 'WORKSPACE_ARTIFACT_MISMATCH');
          }
        }
        const registry = await createReviewTools({
          worktreePath: workspace.descriptor.path, artifacts: request.artifacts, artifactGroups: request.artifactGroups, artifactTypes: request.artifactTypes,
          configManifest: request.configManifest, criticId: request.criticId, audience: 'human',
          runDir: path.resolve(stateDir, 'runs', request.runId, request.id, 'human-tools'), signal: workspace.signal,
        });
        try {
          registry.validateArguments(toolName, args);
          assertClaim();
          const result = await registry.call(toolName, args);
          await workspace.assertUnchanged(); workspace.signal.throwIfAborted();
          assertClaim();
          const tool = registry.tools.find(tool => tool.name === toolName)!;
          transaction(() => {
            assertClaim();
            appendEvent(request.runId, requestId, 'human.tool.executed', 'The claimed reviewer executed a registered Artifact tool.', { name: tool.name, artifactId: tool.artifactId, operation: tool.operation });
          });
          changed();
          return result;
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
      const validated = validateResult(result);
      if (!validated.evidence.length || validated.evidence.some(item => !item.trim())) throw new Error('Human review requires at least one nonempty evidence entry.');
      const first = requestData(requestId);
      if (first) reconcile(first.runId);
      const request = requestData(requestId);
      if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
      if (!reviewerId || request.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
      if (!request.notifiedAt) throw new Error('Human alarm delivery is still pending.');
      let workspace: WorkspaceHandle | undefined;
      let inputsValidated = false;
      try {
        workspace = await workspaceAdapter.reopenWorkspace(request.workspace);
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted(); ensureOpen();
        inputsValidated = true;
        transaction(() => {
          const current = required(requestData(requestId), 'Request');
          if (current.status !== 'WAITING_HUMAN') throw new Error('This human review has already completed or failed.');
          if (current.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
          if (current.workspace.mode === 'lock' && !ownerAlive(ownerData(current.runId))) throw new Error('A lock review requires its monitoring worker to remain alive.');
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
        if (!runData(runId)) throw new Error('Unknown Run.');
        if (ownerData(runId)) throw codedError('Another process already owns this review Run.', 'RUN_ALREADY_OWNED');
        failWithin(runId, error instanceof Error ? error : new Error(errorText(error)));
      });
      changed(); return getRun(runId);
    },
    cancel(runId: string) {
      ensureOpen();
      const error = codedError('Review canceled by requester.', 'REVIEW_CANCELED');
      transaction(() => {
        if (!runData(runId)) throw new Error('Unknown Run.');
        failWithin(runId, error);
      });
      for (const entry of active.values()) if (entry.runId === runId) entry.abort.abort(error);
      changed(); return getRun(runId);
    },
    onChange(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback); },
    async close() {
      if (closed) return;
      if (closing) { await Promise.allSettled([...active.values()].map(entry => entry.promise)); return; }
      closing = true;
      const owned = [...active.values()];
      for (const entry of owned) entry.abort.abort(codedError('The review worker stopped before completion.', 'WORKER_STOPPED'));
      await Promise.allSettled(owned.map(entry => entry.promise));
      listeners.clear(); db.close(); closed = true;
    },
  };
}

export type Broker = ReturnType<typeof createBroker>;
