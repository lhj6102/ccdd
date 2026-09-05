import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareReviewRequests } from '../requester/index.mjs';
import { prepareWorkspace, reopenWorkspace } from '../workspaces/index.mjs';

const terminal = new Set(['GREEN', 'RED', 'ERROR']);
const now = () => new Date().toISOString();
const errorText = error => String(error?.message ?? error).slice(0, 2000);
const copy = value => JSON.parse(JSON.stringify(value));
const codedError = (message, code) => Object.assign(new Error(message), { code });

function validateResult(value) {
  if (!value || !['GREEN', 'RED'].includes(value.verdict) || typeof value.summary !== 'string' || !value.summary.trim() ||
      !Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string')) {
    throw new Error('Review result requires GREEN/RED verdict, a summary, and string evidence[].');
  }
  const result = { verdict: value.verdict, summary: value.summary.slice(0, 12_000), evidence: value.evidence.slice(0, 100).map(item => item.slice(0, 4000)) };
  for (const key of ['provider', 'model', 'stdout', 'stderr']) if (typeof value[key] === 'string') result[key] = value[key].slice(0, 24_000);
  for (const key of ['durationMs', 'exitCode']) if (Number.isFinite(value[key])) result[key] = value[key];
  if (Array.isArray(value.toolCalls)) result.toolCalls = value.toolCalls.slice(0, 100).filter(item => item && typeof item.name === 'string').map(item => ({ name: item.name, ...(item.arguments === undefined ? {} : { arguments: copy(item.arguments) }) }));
  if (JSON.stringify(result).length > 256_000) throw new Error('Review result exceeds the supported size.');
  return result;
}

function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    return `ps:${execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`;
  } catch { return null; }
}
const ownProcessIdentity = processIdentity(process.pid);

function ownerAlive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; }
  const identity = owner.pid === process.pid ? ownProcessIdentity : processIdentity(owner.pid);
  return !owner.process_identity || !identity || owner.process_identity === identity;
}

function canonicalFuturePath(value) {
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
export function readStateContext(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('An existing stateDir is required.');
  const canonical = fs.realpathSync(stateDir);
  const filename = path.join(canonical, 'broker.sqlite');
  if (!fs.statSync(filename).isFile()) throw new Error('State directory does not contain a broker store.');
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = database.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = row ? JSON.parse(row.value) : null;
    if (!identity || typeof identity.repoPath !== 'string' || !path.isAbsolute(identity.repoPath) || typeof identity.repoId !== 'string') throw new Error('State directory has no valid repository identity.');
    return { ...identity, stateDir: canonical };
  } finally { database.close(); }
}

function prepareStateDirectory(repoPath, stateDir) {
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
export function createBroker({ repoPath, stateDir, repoId = 'demo', executors, workspaceAdapter = { prepareWorkspace, reopenWorkspace } } = {}) {
  try {
    repoPath = fs.realpathSync(repoPath);
    if (!fs.statSync(repoPath).isDirectory()) throw new Error('Workspace must be a directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const identity = readStateContext(stateDir);
    if (canonicalFuturePath(repoPath) !== identity.repoPath) throw new Error('This state directory belongs to a different registered repository.');
    repoPath = identity.repoPath;
  }
  stateDir = prepareStateDirectory(repoPath, stateDir);
  if (typeof repoId !== 'string' || !repoId.trim() || repoId.length > 200) throw new Error('A registered repoId is required (maximum 200 characters).');
  let db;
  try {
    db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_run ON requests(run_id, ordinal);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), request_id TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_owners (run_id TEXT PRIMARY KEY REFERENCES runs(id), pid INTEGER NOT NULL, process_identity TEXT, token TEXT NOT NULL, claimed_at TEXT NOT NULL);`);
    const previousRepo = db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = JSON.stringify({ repoPath, repoId });
    if (previousRepo && previousRepo.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
    db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('registered-repo', identity);
    // Recheck after INSERT OR IGNORE, since another process may initialize concurrently.
    if (db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo').value !== identity) throw new Error('This state directory belongs to a different registered repository.');
  } catch (error) { db?.close(); throw error; }

  let closed = false;
  let closing = false;
  const active = new Map();
  const listeners = new Set();
  const ensureOpen = () => { if (closed || closing) throw new Error('Broker is closed.'); };
  const requireExecutors = () => {
    if (!executors || typeof executors.canExecute !== 'function' || typeof executors.execute !== 'function') throw new Error('Review submission and execution require an executor registry.');
  };
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const requestData = id => {
    const row = db.prepare('SELECT data FROM requests WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const runData = id => {
    const row = db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const ownerData = id => db.prepare('SELECT * FROM run_owners WHERE run_id = ?').get(id);
  const runRequests = id => db.prepare('SELECT data FROM requests WHERE run_id = ? ORDER BY ordinal').all(id).map(row => JSON.parse(row.data));
  const saveRequest = request => db.prepare('UPDATE requests SET status = ?, data = ? WHERE id = ?').run(request.status, JSON.stringify(request), request.id);
  const saveRun = run => db.prepare('UPDATE runs SET status = ?, data = ? WHERE id = ?').run(run.status, JSON.stringify(run), run.id);
  const appendEvent = (runId, requestId, type, message, data = null) => {
    db.prepare('INSERT INTO events(run_id,request_id,created_at,type,message,data) VALUES (?,?,?,?,?,?)').run(runId, requestId, now(), type, message.slice(0, 4000), data === null ? null : JSON.stringify(data));
  };
  const changed = () => { for (const callback of listeners) { try { callback(); } catch {} } };
  const updateRunStatus = runId => {
    const states = runRequests(runId).map(request => request.status);
    const status = states.includes('ERROR') ? 'ERROR' : states.includes('RED') ? 'RED' :
      states.length > 0 && states.every(state => state === 'GREEN') ? 'GREEN' :
      states.includes('RUNNING') ? 'RUNNING' : states.includes('WAITING_HUMAN') ? 'WAITING_HUMAN' :
      states.includes('QUEUED') ? 'QUEUED' : 'ERROR';
    const run = runData(runId);
    if (run.status !== status) {
      run.status = status;
      if (terminal.has(status)) run.completedAt = now();
      saveRun(run);
      appendEvent(runId, null, 'run.status', `Run ${status}`, { status });
    }
  };

  function finishWithin(requestId, { result, error }, expectedStates = ['RUNNING', 'WAITING_HUMAN']) {
    const request = requestData(requestId);
    if (!request || !expectedStates.includes(request.status) || terminal.has(runData(request.runId).status)) return false;
    request.status = error ? 'ERROR' : result.verdict;
    request.result = result ?? null;
    request.error = error ? errorText(error) : null;
    request.errorCode = error?.code ?? null;
    request.completedAt = now();
    saveRequest(request);
    appendEvent(request.runId, request.id, error ? 'request.error' : 'request.completed', error ? request.error : result.summary, { status: request.status, ...(request.errorCode ? { code: request.errorCode } : {}) });
    const requests = runRequests(request.runId);
    const index = requests.findIndex(item => item.id === request.id);
    if (request.status === 'GREEN' && requests[index + 1]) {
      const next = requests[index + 1];
      next.status = 'QUEUED'; next.blockedReason = null; saveRequest(next);
      appendEvent(next.runId, next.id, 'request.queued', `Predecessor ${request.criticId} is GREEN.`);
    } else if (request.status !== 'GREEN') {
      for (const downstream of requests.slice(index + 1)) {
        downstream.status = 'BLOCKED'; downstream.blockedReason = `${request.criticId} returned ${request.status}; downstream reviews cannot start.`; saveRequest(downstream);
      }
    }
    updateRunStatus(request.runId);
    return true;
  }

  function failWithin(runId, error) {
    const run = runData(runId);
    if (!run || terminal.has(run.status)) return;
    const current = runRequests(runId).find(request => ['RUNNING', 'WAITING_HUMAN', 'QUEUED'].includes(request.status));
    if (current) finishWithin(current.id, { error }, ['RUNNING', 'WAITING_HUMAN', 'QUEUED']);
    else {
      run.status = 'ERROR'; run.error = errorText(error); run.completedAt = now(); saveRun(run);
      appendEvent(runId, null, 'run.error', run.error);
    }
  }

  function reconcileWithin(runId) {
    const owner = ownerData(runId);
    if (!owner || ownerAlive(owner)) return;
    const run = runData(runId);
    const waiting = runRequests(runId).find(request => request.status === 'WAITING_HUMAN');
    if (!(run?.workspace?.mode === 'copy' && waiting?.notifiedAt)) {
      failWithin(runId, codedError('The review worker exited before completing its work. Submit a new run to retry.', 'WORKER_EXITED'));
    }
    db.prepare('DELETE FROM run_owners WHERE run_id = ? AND token = ?').run(runId, owner.token);
    appendEvent(runId, null, 'worker.exited', 'The previous review worker is no longer running.');
  }

  function reconcile(runId) {
    ensureOpen();
    transaction(() => {
      if (runId === undefined) for (const row of db.prepare('SELECT run_id FROM run_owners').all()) reconcileWithin(row.run_id);
      else reconcileWithin(runId);
    });
  }

  function getRun(id) {
    ensureOpen();
    if (!runData(id)) return null;
    if (ownerData(id)) reconcile(id);
    const run = runData(id);
    const owner = ownerData(id);
    const events = db.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: event.id, runId: event.run_id, requestId: event.request_id, createdAt: event.created_at, type: event.type, message: event.message, ...(event.data ? { data: JSON.parse(event.data) } : {}) }));
    return { ...run, scope: run.scope ?? { kind: 'chain' }, owner: owner ? { pid: owner.pid, claimedAt: owner.claimed_at } : null, requests: runRequests(id), events };
  }

  function failOwned(runId, token, error) {
    transaction(() => { if (ownerData(runId)?.token === token) failWithin(runId, error); });
    changed();
  }

  async function executeOne(requestId, workspace, token, signal) {
    const initial = requestData(requestId);
    const runId = initial.runId;
    transaction(() => {
      const request = requestData(requestId);
      if (ownerData(runId)?.token !== token || request.status !== 'QUEUED') throw codedError('Review ownership changed before execution.', 'RUN_OWNERSHIP_LOST');
      request.status = 'RUNNING'; request.startedAt = now(); request.blockedReason = null; saveRequest(request);
      appendEvent(runId, request.id, 'request.started', `${request.title}: reviewing ${workspace.descriptor.mode} workspace.`, { snapshotHash: workspace.descriptor.hash });
      updateRunStatus(runId);
    });
    changed();
    try {
      signal.throwIfAborted();
      await workspace.assertUnchanged();
      const request = requestData(requestId);
      const runDir = path.join(stateDir, 'runs', runId, request.id);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      if (request.profile.kind === 'human') {
        if (typeof executors.notifyHuman !== 'function') throw new Error('Human execution requires a registered alarm method.');
        transaction(() => {
          const current = requestData(requestId);
          if (current.status !== 'RUNNING') throw codedError('Review was canceled before Human notification.', 'REVIEW_CANCELED');
          current.status = 'WAITING_HUMAN'; saveRequest(current);
          appendEvent(runId, requestId, 'human.waiting', 'Human review is ready; registered alarm delivery is pending.');
          updateRunStatus(runId);
        });
        await executors.notifyHuman(copy(requestData(requestId)), { signal });
        signal.throwIfAborted();
        await workspace.assertUnchanged();
        transaction(() => {
          const current = requestData(requestId);
          if (current.status !== 'WAITING_HUMAN') return;
          current.notifiedAt = now(); saveRequest(current);
          appendEvent(runId, requestId, 'human.notified', 'Registered human alarm methods confirmed delivery.');
        });
        changed();
        return;
      }
      const result = validateResult(await executors.execute(copy(request), {
        worktreePath: workspace.descriptor.path, workspacePath: workspace.descriptor.path, runDir, signal,
        onEvent(event) {
          if (closed || closing || signal.aborted || !event || requestData(requestId)?.status !== 'RUNNING' || !['executor.started', 'artifact.tools.ready', 'artifact.tool.called', 'executor.completed'].includes(event.type)) return;
          const safe = {};
          for (const key of ['name', 'provider', 'model', 'kind', 'artifactId', 'path']) if (typeof event[key] === 'string') safe[key] = event[key].slice(0, 1000);
          if (Array.isArray(event.tools)) safe.tools = event.tools.slice(0, 32).map(tool => typeof tool === 'string' ? tool : tool?.name).filter(value => typeof value === 'string');
          appendEvent(runId, requestId, event.type, String(event.message ?? event.type).slice(0, 2000), safe);
          changed();
        },
      }));
      await workspace.assertUnchanged();
      signal.throwIfAborted();
      transaction(() => { if (ownerData(runId)?.token === token) finishWithin(requestId, { result }); });
      changed();
    } catch (error) { failOwned(runId, token, signal.aborted ? signal.reason : error); }
  }

  async function run(runId, { signal, onStarted } = {}) {
    ensureOpen(); requireExecutors();
    const token = randomUUID();
    let stored;
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
    const abort = new AbortController();
    const executionSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const entry = { runId, token, abort, promise: null };
    active.set(token, entry);
    entry.promise = (async () => {
      let workspace;
      let poll;
      try {
        onStarted?.({ runId, pid: process.pid });
        workspace = await workspaceAdapter.reopenWorkspace(stored.workspace, { signal: executionSignal });
        const reviewSignal = AbortSignal.any([executionSignal, workspace.signal]);
        poll = setInterval(() => {
          if (ownerData(runId)?.token !== token) abort.abort(codedError('Review ownership was lost.', 'RUN_OWNERSHIP_LOST'));
          else if (terminal.has(runData(runId)?.status)) abort.abort(codedError('Review is already complete or canceled.', 'REVIEW_CANCELED'));
        }, 100);
        while (true) {
          const current = runData(runId);
          if (terminal.has(current.status)) break;
          reviewSignal.throwIfAborted();
          const requests = runRequests(runId);
          const waiting = requests.find(request => request.status === 'WAITING_HUMAN');
          if (waiting) {
            if (!waiting.notifiedAt) throw new Error('Human notification did not complete; submit a new Run to retry.');
            await workspace.assertUnchanged();
            if (stored.workspace.mode === 'copy') {
              // Completion may queue a successor during the asynchronous input check.
              // Release only while still waiting, atomically with the last state check.
              const paused = transaction(() => {
                if (runData(runId).status !== 'WAITING_HUMAN') return false;
                if (ownerData(runId)?.token !== token) throw codedError('Review ownership was lost.', 'RUN_OWNERSHIP_LOST');
                db.prepare('DELETE FROM run_owners WHERE run_id = ? AND token = ?').run(runId, token);
                appendEvent(runId, null, 'worker.paused', 'Copied Human review is persisted; no worker is needed while awaiting a result.');
                return true;
              });
              if (paused) break;
              continue;
            }
            await delay(100, undefined, { signal: reviewSignal });
            continue;
          }
          const queued = requests.find(request => request.status === 'QUEUED');
          if (!queued) throw new Error('Run has no executable request.');
          await executeOne(queued.id, workspace, token, reviewSignal);
        }
      } catch (error) {
        const reason = workspace?.signal.aborted ? workspace.signal.reason : executionSignal.aborted ? executionSignal.reason : error;
        failOwned(runId, token, reason);
      } finally {
        clearInterval(poll);
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
      return { ...runData(runId), requests: runRequests(runId) };
    })();
    return entry.promise;
  }

  return {
    async submit({ mode = 'copy', requesterId, reviewRequests, criticId, snapshotCommit } = {}) {
      ensureOpen(); requireExecutors();
      if (snapshotCommit !== undefined) throw new Error('snapshotCommit is no longer accepted; use mode copy or lock with the current workspace.');
      if (typeof requesterId !== 'string' || !requesterId.trim() || requesterId.length > 200) throw new Error('requesterId is required (maximum 200 characters).');
      if (!['lock', 'copy'].includes(mode)) throw new Error('mode must be lock or copy.');
      const workspace = await workspaceAdapter.prepareWorkspace({ repoPath, stateDir, mode });
      try {
        const descriptor = copy(workspace.descriptor);
        const expected = await prepareReviewRequests({ repoPath: descriptor.path, repoId, snapshotHash: descriptor.hash, criticId });
        const supplied = reviewRequests === undefined ? expected : reviewRequests;
        if (!isDeepStrictEqual(supplied, expected)) throw new Error('Submitted review request envelopes must exactly match the Artifact definitions, payload, profiles and dependency order in the requested workspace.');
        const id = randomUUID();
        const createdAt = now();
        const requests = copy(supplied).map(envelope => ({
          ...envelope, id: randomUUID(), runId: id, workspace: descriptor, worktreePath: descriptor.path,
          predecessorId: null, status: 'BLOCKED', createdAt, startedAt: null, completedAt: null,
          result: null, error: null, claimedBy: null, claimedAt: null, notifiedAt: null,
        }));
        for (const [index, request] of requests.entries()) {
          request.predecessorId = index === 0 ? null : requests[index - 1].id;
          request.status = index === 0 ? 'QUEUED' : 'BLOCKED';
          request.blockedReason = index === 0 ? null : `Waiting for ${requests[index - 1].criticId} to become GREEN.`;
          const capability = await executors.canExecute(copy(request));
          if (!capability?.ok) throw new Error(`Cannot execute ${request.criticId}: ${capability?.reason ?? 'No compatible executor.'}`);
          if (request.profile.kind === 'human' && typeof executors.notifyHuman !== 'function') throw new Error('Human execution requires an alarm method.');
        }
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted(); ensureOpen();
        const scope = criticId === undefined ? { kind: 'chain' } : { kind: 'critic', criticId };
        const record = { id, repoId, snapshotHash: descriptor.hash, workspace: descriptor, requesterId, scope, status: 'QUEUED', createdAt };
        transaction(() => {
          db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?)').run(id, createdAt, record.status, JSON.stringify(record));
          requests.forEach((request, index) => db.prepare('INSERT INTO requests(id,run_id,ordinal,status,data) VALUES (?,?,?,?,?)').run(request.id, id, index, request.status, JSON.stringify(request)));
          appendEvent(id, null, 'run.submitted', 'Review persisted; a request-scoped worker can execute it.', { snapshotHash: descriptor.hash, mode, requesterId, scope });
          appendEvent(id, null, 'workspace.ready', mode === 'copy' ? 'Content-addressed copied workspace is ready.' : 'Current workspace is fixed for this review; changes invalidate it.', { path: descriptor.path, snapshotHash: descriptor.hash });
        });
        changed();
        return getRun(id);
      } finally { await workspace.close(); }
    },
    run,
    reconcile,
    listRuns() {
      ensureOpen();
      return db.prepare('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC').all().map(row => {
        const record = getRun(row.id);
        return { ...record, events: undefined, requests: record.requests.map(({ result, ...request }) => ({ ...request, result: result ? { verdict: result.verdict, summary: result.summary } : null })) };
      });
    },
    getRun,
    getRequest(id) {
      ensureOpen();
      const request = requestData(id);
      if (request) reconcile(request.runId);
      return requestData(id);
    },
    claimHuman(requestId, reviewerId) {
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
    async completeHuman(requestId, { reviewerId, result }) {
      ensureOpen();
      const validated = validateResult(result);
      const first = requestData(requestId);
      if (first) reconcile(first.runId);
      const request = requestData(requestId);
      if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
      if (!reviewerId || request.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
      if (!request.notifiedAt) throw new Error('Human alarm delivery is still pending.');
      let workspace;
      let inputsValidated = false;
      try {
        workspace = await workspaceAdapter.reopenWorkspace(request.workspace);
        await workspace.assertUnchanged(); workspace.signal.throwIfAborted(); ensureOpen();
        inputsValidated = true;
        transaction(() => {
          const current = requestData(requestId);
          if (current.status !== 'WAITING_HUMAN') throw new Error('This human review has already completed or failed.');
          if (current.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
          if (current.workspace.mode === 'lock' && !ownerAlive(ownerData(current.runId))) throw new Error('A lock review requires its monitoring worker to remain alive.');
          workspace.signal.throwIfAborted();
          finishWithin(requestId, { result: validated });
        });
      } catch (error) {
        // A workspace failure invalidates the review; a competing completed result is immutable.
        if (!inputsValidated || error.code?.startsWith('WORKSPACE_')) {
          transaction(() => { finishWithin(requestId, { error }); }); changed();
        }
        throw error;
      } finally { await workspace?.close(); }
      changed();
      return requestData(requestId);
    },
    failRun(runId, error) {
      ensureOpen();
      transaction(() => {
        reconcileWithin(runId);
        if (!runData(runId)) throw new Error('Unknown Run.');
        if (ownerData(runId)) throw codedError('Another process already owns this review Run.', 'RUN_ALREADY_OWNED');
        failWithin(runId, error instanceof Error ? error : new Error(errorText(error)));
      });
      changed(); return getRun(runId);
    },
    cancel(runId) {
      ensureOpen();
      const error = codedError('Review canceled by requester.', 'REVIEW_CANCELED');
      transaction(() => {
        if (!runData(runId)) throw new Error('Unknown Run.');
        failWithin(runId, error);
      });
      for (const entry of active.values()) if (entry.runId === runId) entry.abort.abort(error);
      changed(); return getRun(runId);
    },
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
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
