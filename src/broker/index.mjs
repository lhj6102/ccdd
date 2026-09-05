import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { git } from './config.mjs';
import { prepareReviewRequests } from '../requester/index.mjs';

const terminal = new Set(['GREEN', 'RED', 'ERROR']);
const now = () => new Date().toISOString();
const errorText = error => String(error?.message ?? error).slice(0, 2000);
const copy = value => JSON.parse(JSON.stringify(value));

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

function acquireOwnership(stateDir) {
  const lockPath = path.join(stateDir, 'broker-owner.json');
  const token = randomUUID();
  const write = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, createdAt: now() }), { flag: 'wx', mode: 0o600 });
  try { write(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { throw new Error('Broker ownership file is unreadable; inspect it before restarting.'); }
    let alive = true;
    try { process.kill(existing.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Another broker already owns this state directory.');
    fs.unlinkSync(lockPath);
    write();
  }
  return () => {
    try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === token) fs.unlinkSync(lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

export function createBroker({ repoPath, stateDir, repoId = 'demo', executors }) {
  if (!executors || typeof executors.canExecute !== 'function' || typeof executors.execute !== 'function') throw new Error('Broker requires an executor registry.');
  repoPath = fs.realpathSync(repoPath);
  stateDir = path.resolve(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const releaseOwnership = acquireOwnership(stateDir);
  let db;
  try {
    db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_run ON requests(run_id, ordinal);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), request_id TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const previousRepo = db.prepare('SELECT value FROM metadata WHERE key = ?').get('registered-repo');
    const identity = JSON.stringify({ repoPath, repoId });
    if (previousRepo && previousRepo.value !== identity) throw new Error('This state directory belongs to a different registered repository.');
    db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('registered-repo', identity);
  } catch (error) { db?.close(); releaseOwnership(); throw error; }

  let closed = false;
  let closing = false;
  let scheduled = false;
  let worker = null;
  let activeAbort = null;
  const listeners = new Set();
  const ensureOpen = () => { if (closed || closing) throw new Error('Broker is closed.'); };
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const requestData = id => {
    const row = db.prepare('SELECT data FROM requests WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const runRequests = id => db.prepare('SELECT data FROM requests WHERE run_id = ? ORDER BY ordinal').all(id).map(row => JSON.parse(row.data));
  const saveRequest = request => db.prepare('UPDATE requests SET status = ?, data = ? WHERE id = ?').run(request.status, JSON.stringify(request), request.id);
  const appendEvent = (runId, requestId, type, message, data = null) => {
    db.prepare('INSERT INTO events(run_id,request_id,created_at,type,message,data) VALUES (?,?,?,?,?,?)').run(runId, requestId, now(), type, message.slice(0, 4000), data === null ? null : JSON.stringify(data));
  };
  const changed = () => { for (const callback of listeners) { try { callback(); } catch {} } };
  const updateRunStatus = runId => {
    const requests = runRequests(runId);
    const states = requests.map(request => request.status);
    const status = states.includes('ERROR') ? 'ERROR' : states.includes('RED') ? 'RED' :
      states.length > 0 && states.every(state => state === 'GREEN') ? 'GREEN' :
      states.includes('RUNNING') ? 'RUNNING' : states.includes('WAITING_HUMAN') ? 'WAITING_HUMAN' :
      states.includes('QUEUED') ? 'QUEUED' : 'ERROR';
    const row = db.prepare('SELECT data FROM runs WHERE id = ?').get(runId);
    const run = JSON.parse(row.data);
    if (run.status !== status) {
      run.status = status;
      if (terminal.has(status)) run.completedAt = now();
      db.prepare('UPDATE runs SET status = ?, data = ? WHERE id = ?').run(status, JSON.stringify(run), runId);
      appendEvent(runId, null, 'run.status', `Run ${status}`, { status });
    }
  };

  function stopInterrupted(message) {
    transaction(() => {
      for (const row of db.prepare("SELECT id FROM runs WHERE status NOT IN ('GREEN','RED','ERROR')").all()) {
        for (const request of runRequests(row.id)) {
          if (['QUEUED', 'RUNNING', 'WAITING_HUMAN'].includes(request.status)) {
            request.status = 'ERROR'; request.error = message; request.completedAt = now(); saveRequest(request);
            appendEvent(row.id, request.id, 'request.error', message);
          } else if (request.status === 'BLOCKED') {
            request.blockedReason = 'An interrupted predecessor requires a new review submission.'; saveRequest(request);
          }
        }
        updateRunStatus(row.id);
      }
    });
  }
  stopInterrupted('Broker restarted before the review completed. Submit a new run to retry.');

  function getRun(id) {
    const row = db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    if (!row) return null;
    const events = db.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: event.id, runId: event.run_id, requestId: event.request_id, createdAt: event.created_at, type: event.type, message: event.message, ...(event.data ? { data: JSON.parse(event.data) } : {}) }));
    return { ...JSON.parse(row.data), requests: runRequests(id), events };
  }

  function finish(requestId, { result, error }) {
    transaction(() => {
      const request = requestData(requestId);
      if (!request || !['RUNNING', 'WAITING_HUMAN'].includes(request.status)) return;
      request.status = error ? 'ERROR' : result.verdict;
      request.result = result ?? null;
      request.error = error ? errorText(error) : null;
      request.completedAt = now();
      saveRequest(request);
      appendEvent(request.runId, request.id, error ? 'request.error' : 'request.completed', error ? request.error : result.summary, { status: request.status });
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
    });
    changed();
    schedule();
  }

  async function assertSnapshot(request) {
    const head = (await git(request.worktreePath, ['rev-parse', 'HEAD'])).trim();
    const modified = (await git(request.worktreePath, ['status', '--porcelain', '--untracked-files=no'])).trim();
    if (head !== request.snapshotCommit || modified) throw new Error('Review changed tracked snapshot files or HEAD; result was rejected.');
  }

  async function executeOne(request) {
    transaction(() => {
      request.status = 'RUNNING'; request.startedAt = now(); request.blockedReason = null; saveRequest(request);
      appendEvent(request.runId, request.id, 'request.started', `${request.title}: preparing immutable snapshot.`);
      updateRunStatus(request.runId);
    });
    changed();
    activeAbort = new AbortController();
    try {
      const worktreePath = path.join(stateDir, 'worktrees', request.runId, request.id);
      const runDir = path.join(stateDir, 'runs', request.runId, request.id);
      const hooksPath = path.join(stateDir, 'empty-hooks');
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(hooksPath, { recursive: true });
      await git(repoPath, ['-c', `core.hooksPath=${hooksPath}`, 'worktree', 'add', '--detach', worktreePath, request.snapshotCommit], { signal: activeAbort.signal });
      if (closing) throw new Error('Broker is shutting down.');
      request.worktreePath = worktreePath;
      saveRequest(request);
      appendEvent(request.runId, request.id, 'snapshot.ready', 'Detached snapshot worktree is ready.', { snapshotCommit: request.snapshotCommit });
      changed();
      if (request.profile.kind === 'human') {
        if (typeof executors.notifyHuman !== 'function') throw new Error('Human execution requires a registered alarm method.');
        transaction(() => {
          request.status = 'WAITING_HUMAN'; saveRequest(request);
          appendEvent(request.runId, request.id, 'human.waiting', 'Human review is ready; registered alarm delivery is pending.');
          updateRunStatus(request.runId);
        });
        await executors.notifyHuman(copy(request));
        appendEvent(request.runId, request.id, 'human.notified', 'Registered human alarm methods confirmed delivery.');
        changed();
        return;
      }
      const result = validateResult(await executors.execute(copy(request), {
        worktreePath, runDir, signal: activeAbort.signal,
        onEvent(event) {
          if (closed || closing || !event || !['executor.started', 'artifact.tools.ready', 'artifact.tool.called', 'executor.completed'].includes(event.type)) return;
          const safe = {};
          for (const key of ['name', 'provider', 'model', 'kind', 'artifactId', 'path']) if (typeof event[key] === 'string') safe[key] = event[key].slice(0, 1000);
          if (Array.isArray(event.tools)) safe.tools = event.tools.slice(0, 32).map(tool => typeof tool === 'string' ? tool : tool?.name).filter(value => typeof value === 'string');
          appendEvent(request.runId, request.id, event.type, String(event.message ?? event.type).slice(0, 2000), safe);
          changed();
        },
      }));
      await assertSnapshot(request);
      if (closing) throw new Error('Broker stopped before review completion.');
      finish(request.id, { result });
    } catch (error) { finish(request.id, { error }); }
    finally { activeAbort = null; }
  }

  function schedule() {
    if (closing || closed || scheduled || worker) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closing || closed || worker) return;
      worker = (async () => {
        while (!closing) {
          const row = db.prepare("SELECT q.data FROM requests q JOIN runs r ON r.id = q.run_id WHERE q.status = 'QUEUED' AND r.status NOT IN ('GREEN','RED','ERROR') ORDER BY r.created_at, q.ordinal LIMIT 1").get();
          if (!row) break;
          await executeOne(JSON.parse(row.data));
        }
      })().catch(error => { stopInterrupted(`Broker worker failed: ${errorText(error)}`); changed(); }).finally(() => {
        worker = null;
        if (!closing && db.prepare("SELECT 1 FROM requests q JOIN runs r ON r.id = q.run_id WHERE q.status = 'QUEUED' AND r.status NOT IN ('GREEN','RED','ERROR') LIMIT 1").get()) schedule();
      });
    });
  }

  return {
    async submit({ snapshotCommit, requesterId, reviewRequests }) {
      ensureOpen();
      if (typeof requesterId !== 'string' || !requesterId.trim() || requesterId.length > 200) throw new Error('requesterId is required (maximum 200 characters).');
      const expected = await prepareReviewRequests({ repoPath, repoId, snapshotCommit });
      const supplied = reviewRequests === undefined ? expected : reviewRequests;
      if (!isDeepStrictEqual(supplied, expected)) {
        throw new Error('Submitted review request envelopes must exactly match the Artifact definitions, payload, profiles and dependency order in the requested snapshot.');
      }
      const envelopes = copy(supplied);
      ensureOpen();
      const id = randomUUID();
      const createdAt = now();
      const requests = envelopes.map(envelope => ({
        ...envelope, id: randomUUID(), runId: id,
        predecessorId: null, status: 'BLOCKED', createdAt, startedAt: null, completedAt: null,
        result: null, error: null, worktreePath: null, claimedBy: null, claimedAt: null,
      }));
      for (const [index, request] of requests.entries()) {
        request.predecessorId = index === 0 ? null : requests[index - 1].id;
        request.status = index === 0 ? 'QUEUED' : 'BLOCKED';
        request.blockedReason = index === 0 ? null : `Waiting for ${requests[index - 1].criticId} to become GREEN.`;
        const capability = await executors.canExecute(copy(request));
        if (!capability?.ok) throw new Error(`Cannot execute ${request.criticId}: ${capability?.reason ?? 'No compatible executor.'}`);
        if (request.profile.kind === 'human' && typeof executors.notifyHuman !== 'function') throw new Error('Human execution requires an alarm method.');
      }
      ensureOpen();
      const run = { id, repoId, snapshotCommit: envelopes[0].snapshotCommit, requesterId, status: 'QUEUED', createdAt };
      transaction(() => {
        db.prepare('INSERT INTO runs(id,created_at,status,data) VALUES (?,?,?,?)').run(id, createdAt, run.status, JSON.stringify(run));
        requests.forEach((request, index) => db.prepare('INSERT INTO requests(id,run_id,ordinal,status,data) VALUES (?,?,?,?,?)').run(request.id, id, index, request.status, JSON.stringify(request)));
        appendEvent(id, null, 'run.submitted', 'Review request persisted; execution will proceed asynchronously.', { snapshotCommit: run.snapshotCommit, requesterId });
      });
      changed(); schedule();
      return getRun(id);
    },
    listRuns() {
      return db.prepare('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC').all().map(row => {
        const run = getRun(row.id);
        return { ...run, events: undefined, requests: run.requests.map(({ result, ...request }) => ({ ...request, result: result ? { verdict: result.verdict, summary: result.summary } : null })) };
      });
    },
    getRun,
    getRequest: requestData,
    claimHuman(requestId, reviewerId) {
      ensureOpen();
      if (typeof reviewerId !== 'string' || !reviewerId.trim() || reviewerId.length > 200) throw new Error('A reviewerId is required.');
      const request = requestData(requestId);
      if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
      if (request.claimedBy && request.claimedBy !== reviewerId) throw new Error('This review is already claimed by another reviewer.');
      if (!request.claimedBy) transaction(() => {
        request.claimedBy = reviewerId; request.claimedAt = now(); saveRequest(request);
        appendEvent(request.runId, request.id, 'human.claimed', `Review claimed by ${reviewerId}.`);
      });
      changed(); return requestData(requestId);
    },
    async completeHuman(requestId, { reviewerId, result }) {
      ensureOpen();
      const request = requestData(requestId);
      if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
      if (!reviewerId || request.claimedBy !== reviewerId) throw new Error('Only the reviewer who claimed this request can submit its result.');
      const validated = validateResult(result);
      try { await assertSnapshot(request); }
      catch (error) { if (!closed && !closing) finish(requestId, { error }); throw error; }
      ensureOpen();
      if (requestData(requestId).status !== 'WAITING_HUMAN') throw new Error('This human review has already completed.');
      finish(requestId, { result: validated });
      return requestData(requestId);
    },
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    async close() {
      if (closed) return;
      if (closing) { await worker; return; }
      closing = true;
      activeAbort?.abort(new Error('Broker is shutting down.'));
      await worker;
      stopInterrupted('Broker stopped before the review completed. Submit a new run to retry.');
      listeners.clear(); db.close(); closed = true; releaseOwnership();
    },
  };
}
