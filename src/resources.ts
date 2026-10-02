import type { ExecutionProvenance } from './provenance.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerAlive, ownProcessIdentity, processIdentity } from './broker/ownership.js';
import type { Admission, AdmissionRequest, AdmissionLease } from './broker/admission.js';

export interface ResourceConfiguration {
  identityCapacity: number;
  defaultProviderCapacity: number;
  providers: Record<string, { capacity: number; models?: Record<string, number> }>;
}
export const resourceDefaults: ResourceConfiguration = { identityCapacity: 100, defaultProviderCapacity: 4, providers: {} };
export function resourcePaths() {
  return { config: join(process.env.CCDD_CONFIG_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ccdd'), 'resources.json'),
    database: join(process.env.CCDD_STATE_HOME || join(homedir(), '.local', 'state', 'ccdd'), 'resources.sqlite') };
}
function integer(value: unknown, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value as number;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function readResourceConfiguration(): ResourceConfiguration {
  let input: unknown;
  try { input = JSON.parse(readFileSync(resourcePaths().config, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(resourceDefaults); throw error; }
  if (!record(input) || Object.keys(input).some(key => !['identityCapacity', 'defaultProviderCapacity', 'providers'].includes(key))) throw new Error('Invalid local resources.json; allowed fields: identityCapacity, defaultProviderCapacity, providers.');
  const providers: ResourceConfiguration['providers'] = {};
  if (input.providers !== undefined && !record(input.providers)) throw new Error('providers must be a map.');
  for (const [name, value] of Object.entries(input.providers ?? {})) {
    if (!name || !record(value) || Object.keys(value).some(key => !['capacity', 'models'].includes(key))) throw new Error('Each provider requires capacity and optional models.');
    if (value.models !== undefined && !record(value.models)) throw new Error('models must map model names to capacities.');
    const models = Object.fromEntries(Object.entries(value.models ?? {}).map(([model, capacity]) => [model, integer(capacity, `providers.${name}.models.${model}`)]));
    providers[name] = { capacity: integer(value.capacity, `providers.${name}.capacity`), ...(value.models === undefined ? {} : { models }) };
  }
  return { identityCapacity: integer(input.identityCapacity ?? 100, 'identityCapacity'), defaultProviderCapacity: integer(input.defaultProviderCapacity ?? 4, 'defaultProviderCapacity'), providers };
}
export function canonicalRepositoryId(repoPath: string): string { let canonical: string; try { canonical = realpathSync(repoPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; canonical = resolve(repoPath); } return createHash('sha256').update(canonical).digest('hex'); }
export function rejectIdentityConcurrency(value: unknown): void { if (value !== undefined) throw new Error('identityConcurrency/--identity-concurrency was removed. Set local resources.json identityCapacity (default 100) and Artifact stale.weight (1–100, default 25).'); }
export function validateIdentityWeight(weight = 25, config = readResourceConfiguration()): number {
  integer(weight, 'Identity weight');
  if (weight > 100) throw new Error('Identity weight must be an integer from 1 to 100.');
  if (weight > config.identityCapacity) throw new Error(`Identity weight ${weight} exceeds local identityCapacity ${config.identityCapacity}; raise local capacity or lower the declared weight.`);
  return weight;
}
export function validateMaxExecutions(value: number | undefined): void { if (value !== undefined) integer(value, 'maxExecutions', 0); }
interface LeaseRow { token: string; pid: number; process_identity: string | null; lane: string; state: string; run_id: string | null; weight: number; provider: string | null; model: string | null; repo: string; repo_cap: number | null; seq: number }
export interface ResourceLease extends AdmissionLease { token: string; started(provenance?: ExecutionProvenance | null): void; terminal(): void; trackChild(pid: number): () => void }
/** One machine database is authoritative. No repository store transaction encloses a wait. */
export const resourceTestHooks: { admissionWrite?: () => void; reclaim?: () => void } = {};
const sqliteBusy = (error: unknown): boolean => !!error && typeof error === 'object' && ((Number((error as { errcode?: number }).errcode) & 255) === 5 || (error as { code?: string }).code === 'SQLITE_BUSY');
const resourceBusy = (cause: unknown) => Object.assign(new Error('Machine resource storage is busy; retry the operation.', { cause }), { code: 'RESOURCE_BUSY', retryable: true });
export function openResources() {
  const filename = resourcePaths().database;
  mkdirSync(join(filename, '..'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, max_executions INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resource_leases (seq INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, pid INTEGER NOT NULL, process_identity TEXT, heartbeat INTEGER NOT NULL,
      lane TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT REFERENCES submissions(id), request_id TEXT, provider TEXT, model TEXT, repo TEXT NOT NULL, repo_cap INTEGER, weight INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS resource_lane ON resource_leases(lane,state,seq);
    CREATE TABLE IF NOT EXISTS execution_attempts (token TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES submissions(id), request_id TEXT NOT NULL, state TEXT NOT NULL, reserved_at TEXT NOT NULL, started_at TEXT, terminal_at TEXT);
    CREATE INDEX IF NOT EXISTS budget_attempts ON execution_attempts(run_id,state);
    CREATE TABLE IF NOT EXISTS resource_children (token TEXT NOT NULL, pid INTEGER NOT NULL, process_identity TEXT, PRIMARY KEY(token,pid));`);
  if (!db.prepare('PRAGMA table_info(execution_attempts)').all().some(row => row.name === 'provenance')) { transactionInit(); }
  function transactionInit() { db.exec('BEGIN IMMEDIATE'); try { if (!db.prepare('PRAGMA table_info(execution_attempts)').all().some(row => row.name === 'provenance')) db.exec('ALTER TABLE execution_attempts ADD COLUMN provenance TEXT'); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
  let closed = false;
  const transaction = <T>(fn: () => T): T => {
    let began = false;
    try { db.exec('BEGIN IMMEDIATE'); began = true; const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { if (began) { try { db.exec('ROLLBACK'); } catch {} } throw error; }
  };
  // Short SQLite waits on async admission paths allow streams, cancellations and
  // the process holding the lock to progress. LOCKED is not BUSY: an invalid
  // connection/statement state must not be retried as cross-process contention.
  const retryBusy = async <T>(fn: () => T, signal?: AbortSignal): Promise<T> => {
    const deadline = performance.now() + 5000;
    let backoff = 10;
    for (;;) {
      signal?.throwIfAborted();
      try { db.exec('PRAGMA busy_timeout=25'); return fn(); }
      catch (error) { if (!sqliteBusy(error)) throw error; if (performance.now() >= deadline) throw resourceBusy(error); }
      finally { db.exec('PRAGMA busy_timeout=5000'); }
      await delay(Math.min(backoff, Math.max(1, deadline - performance.now())) + Math.floor(Math.random() * 10), undefined, { signal });
      backoff = Math.min(200, backoff * 2);
    }
  };
  let nextReclaim = 0;
  function childrenGone(token: string): boolean {
    const children = db.prepare('SELECT * FROM resource_children WHERE token=?').all(token);
    let gone = true;
    for (const child of children) {
      const pid = Number(child.pid);
      if (process.platform === 'linux') {
        // Detached launch groups retain orphan descendants after their leader dies.
        const members = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
          try { const stat = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return Number(fields[2]) === pid && fields[0] !== 'Z' ? [{ pid: Number(name), identity: `linux:${fields[19]}` }] : []; } catch { return []; }
        });
        // Never signal a reused group leader. An orphan group cannot be reused while it has members.
        const identity = processIdentity(pid);
        if (identity && identity !== child.process_identity) { db.prepare('DELETE FROM resource_children WHERE token=? AND pid=?').run(token, pid); continue; }
        for (const member of members) {
          if (processIdentity(member.pid) !== member.identity) continue;
          try { process.kill(member.pid, 'SIGKILL'); } catch {}
        }
        if (members.length) gone = false;
        else db.prepare('DELETE FROM resource_children WHERE token=? AND pid=?').run(token, pid);
      } else if (ownerAlive({ pid, process_identity: child.process_identity as string | null, run_id: '', token, claimed_at: '' })) {
        try { process.kill(pid, 'SIGKILL'); } catch {} gone = false;
      } else db.prepare('DELETE FROM resource_children WHERE token=? AND pid=?').run(token, pid);
    }
    return gone;
  }
  function reclaim() {
    if (performance.now() < nextReclaim) return;
    nextReclaim = performance.now() + 250; resourceTestHooks.reclaim?.();
    // A bounded release failure leaves an accountable cleanup row, not an eternal live-owner slot.
    for (const row of db.prepare("SELECT token FROM resource_leases WHERE state='releasing'").all()) {
      if (!childrenGone(String(row.token))) continue;
      db.prepare("UPDATE execution_attempts SET state='refunded',terminal_at=? WHERE token=? AND state='reserved'").run(new Date().toISOString(), row.token);
      db.prepare('DELETE FROM resource_leases WHERE token=?').run(row.token);
    }
    const owners = db.prepare('SELECT DISTINCT pid,process_identity FROM resource_leases').all() as unknown as LeaseRow[];
    for (const owner of owners) {
      if (ownerAlive({ ...owner, run_id: '', token: '', claimed_at: '' })) continue;
      // Only a positively dead process is reclaimed; heartbeat age alone is never authority.
      const rows = db.prepare('SELECT token FROM resource_leases WHERE pid=? AND process_identity IS ?').all(owner.pid, owner.process_identity);
      for (const row of rows) {
        if (!childrenGone(String(row.token))) continue;
        db.prepare("UPDATE execution_attempts SET state='refunded',terminal_at=? WHERE token=? AND state='reserved'").run(new Date().toISOString(), row.token);
        db.prepare('DELETE FROM resource_leases WHERE token=?').run(row.token);
      }
    }
  }
  function release(token: string) {
    transaction(() => {
      const row = db.prepare('SELECT pid,process_identity FROM resource_leases WHERE token=?').get(token);
      if (!row || row.pid !== process.pid || row.process_identity !== ownProcessIdentity) return;
      if (!childrenGone(token)) throw new Error('Child cleanup has not completed; resource lease is retained.');
      db.prepare("UPDATE execution_attempts SET state='refunded',terminal_at=? WHERE token=? AND state='reserved'").run(new Date().toISOString(), token);
      db.prepare('DELETE FROM resource_leases WHERE token=?').run(token);
    });
  }
  async function acquire(request: AdmissionRequest & { repo: string; repoCap?: number; identityWeight?: number }, { signal, waiting }: { signal: AbortSignal; waiting(reason: string): void }): Promise<ResourceLease> {
    signal.throwIfAborted();
    const identity = request.identityWeight !== undefined, config = readResourceConfiguration();
    const weight = identity ? validateIdentityWeight(request.identityWeight, config) : 1;
    if (request.repoCap !== undefined) integer(request.repoCap, 'Repository executor cap');
    const provider = identity ? null : request.provider ?? '$runtime', model = request.model ?? null;
    const lane = identity ? 'identity' : `provider:${provider}`, token = randomUUID();
    await retryBusy(() => transaction(() => {
      reclaim();
      if (!identity && !db.prepare('SELECT id FROM submissions WHERE id=?').get(request.runId)) throw new Error('Submission has no durable execution budget. Stop old workers and resubmit with the current worker protocol.');
      db.prepare("INSERT INTO resource_leases(token,pid,process_identity,heartbeat,lane,state,run_id,request_id,provider,model,repo,repo_cap,weight) VALUES(?,?,?,?,?,'waiting',?,?,?,?,?,?,?)")
        .run(token, process.pid, ownProcessIdentity, Date.now(), lane, identity ? null : request.runId, request.requestId, provider, model, request.repo, request.repoCap ?? null, weight);
    }), signal);
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      let reported = false;
      while (true) {
        signal.throwIfAborted();
        const admitted = await retryBusy(() => {
          // A blocked waiter normally performs reads only. Queue/capacity checks
          // are repeated inside the write transaction; this precheck grants nothing.
          if (performance.now() >= nextReclaim) transaction(reclaim);
          const candidate = db.prepare('SELECT * FROM resource_leases WHERE token=?').get(token) as unknown as LeaseRow | undefined;
          if (!candidate) throw new Error('Resource lease disappeared before admission.');
          if (db.prepare("SELECT 1 FROM resource_leases WHERE lane=? AND state='waiting' AND seq<? LIMIT 1").get(lane, candidate.seq)) return false;
          const limits = readResourceConfiguration();
          const active = db.prepare("SELECT * FROM resource_leases WHERE state IN ('active','releasing')").all() as unknown as LeaseRow[];
          if (identity && active.filter(row => row.lane === lane).reduce((sum, row) => sum + row.weight, 0) + weight > limits.identityCapacity) return false;
          if (!identity) {
            const pool = limits.providers[provider!];
            if (active.filter(row => row.provider === provider).length >= (pool?.capacity ?? limits.defaultProviderCapacity)) return false;
            const modelCap = model ? pool?.models?.[model] : undefined;
            if (modelCap !== undefined && active.filter(row => row.provider === provider && row.model === model).length >= modelCap) return false;
            const peers = active.filter(row => row.repo === request.repo && row.lane !== 'identity');
            const caps = [...peers.flatMap(row => row.repo_cap === null ? [] : [row.repo_cap]), ...request.repoCap === undefined ? [] : [request.repoCap]];
            if (caps.length && peers.length >= Math.min(...caps)) return false;
          }
          return transaction(() => {
          resourceTestHooks.admissionWrite?.();
          const current = db.prepare('SELECT * FROM resource_leases WHERE token=?').get(token) as unknown as LeaseRow | undefined;
          if (!current) throw new Error('Resource lease disappeared before admission.');
          const limits = readResourceConfiguration();
          if (identity) validateIdentityWeight(weight, limits);
          const earlier = db.prepare("SELECT token FROM resource_leases WHERE lane=? AND state='waiting' AND seq<? LIMIT 1").get(lane, current.seq);
          if (earlier) return false;
          const active = db.prepare("SELECT * FROM resource_leases WHERE state IN ('active','releasing')").all() as unknown as LeaseRow[];
          if (identity) { if (active.filter(row => row.lane === lane).reduce((sum, row) => sum + row.weight, 0) + weight > limits.identityCapacity) return false; }
          else {
            const pool = limits.providers[provider!], capacity = pool?.capacity ?? limits.defaultProviderCapacity;
            if (active.filter(row => row.provider === provider).length >= capacity) return false;
            const modelCapacity = model ? pool?.models?.[model] : undefined;
            if (modelCapacity !== undefined && active.filter(row => row.provider === provider && row.model === model).length >= modelCapacity) return false;
            // All active declarations participate, so callers cannot raise a running repo's tighter cap.
            const peers = active.filter(row => row.repo === request.repo && row.lane !== 'identity');
            const caps = [...peers.flatMap(row => row.repo_cap === null ? [] : [row.repo_cap]), ...request.repoCap === undefined ? [] : [request.repoCap]];
            if (caps.length && peers.length >= Math.min(...caps)) return false;
            const budget = db.prepare('SELECT max_executions FROM submissions WHERE id=?').get(request.runId)!;
            const used = Number(db.prepare("SELECT count(*) AS n FROM execution_attempts WHERE run_id=? AND state!='refunded'").get(request.runId)!.n);
            if (budget.max_executions !== null && used >= Number(budget.max_executions)) throw Object.assign(new Error(`Submission maxExecutions ${budget.max_executions} exhausted; reuse/coalescing does not authorize another start.`), { code: 'EXECUTION_BUDGET_EXHAUSTED' });
            db.prepare("INSERT INTO execution_attempts(token,run_id,request_id,state,reserved_at) VALUES(?,?,?,'reserved',?)").run(token, request.runId, request.requestId, new Date().toISOString());
          }
          db.prepare("UPDATE resource_leases SET state='active',heartbeat=? WHERE token=?").run(Date.now(), token);
          return true;
          });
        }, signal);
        if (admitted) break;
        if (!reported) { waiting(identity ? 'Waiting for machine identity capacity (FIFO).' : `Waiting for machine provider capacity: ${provider} (FIFO).`); reported = true; }
        await delay(40 + Math.floor(Math.random() * 20), undefined, { signal });
      }
      let released = false;
      heartbeat = setInterval(() => { if (!closed) { try { db.prepare('UPDATE resource_leases SET heartbeat=? WHERE token=? AND pid=? AND process_identity IS ?').run(Date.now(), token, process.pid, ownProcessIdentity); } catch { /* A bounded busy failure cannot invalidate a live holder. */ } } }, 2000);
      heartbeat.unref();
      return { token,
        trackChild(pid: number) {
          const identity = processIdentity(pid);
          db.prepare('INSERT INTO resource_children(token,pid,process_identity) VALUES(?,?,?)').run(token, pid, identity);
          return () => { if (process.platform !== 'linux') db.prepare('DELETE FROM resource_children WHERE token=? AND pid=? AND process_identity IS ?').run(token, pid, identity); };
        },
        started(provenance = null) { transaction(() => {
          const lease = db.prepare("SELECT token FROM resource_leases WHERE token=? AND pid=? AND process_identity IS ? AND state='active'").get(token, process.pid, ownProcessIdentity);
          if (!lease) throw new Error('Resource ownership lost before execution start.');
          db.prepare("UPDATE execution_attempts SET state='started',started_at=?,provenance=? WHERE token=? AND state='reserved'").run(new Date().toISOString(), provenance === null ? null : JSON.stringify(provenance), token);
        }); },
        terminal() { transaction(() => { db.prepare("UPDATE execution_attempts SET state='terminal',terminal_at=? WHERE token=? AND state='started'").run(new Date().toISOString(), token); }); },
        async release() {
          if (released) return;
          await retryBusy(() => db.prepare("UPDATE resource_leases SET state='releasing' WHERE token=? AND pid=? AND process_identity IS ?").run(token, process.pid, ownProcessIdentity));
          const deadline = Date.now() + 5000;
          while (!await retryBusy(() => transaction(() => childrenGone(token)))) { if (Date.now() >= deadline) throw new Error('Tracked child cleanup exceeded 5000 ms; resource lease remains held.'); await delay(10); }
          await retryBusy(() => release(token)); released = true; clearInterval(heartbeat);
        },
      };
    } catch (error) {
      clearInterval(heartbeat);
      try { await retryBusy(() => release(token)); } catch { /* Preserve the original error; dead-owner cleanup retains authority. */ }
      throw signal.aborted ? signal.reason : error;
    }
  }
  return {
    registerSubmission(id: string, maxExecutions?: number) { validateMaxExecutions(maxExecutions); transaction(() => {
      db.prepare('INSERT OR IGNORE INTO submissions(id,max_executions,created_at) VALUES(?,?,?)').run(id, maxExecutions ?? null, new Date().toISOString());
      if (db.prepare('SELECT max_executions FROM submissions WHERE id=?').get(id)!.max_executions !== (maxExecutions ?? null)) throw new Error('A submission budget is immutable.');
    }); },
    budget(id: string) { const row = db.prepare('SELECT max_executions FROM submissions WHERE id=?').get(id); return row ? { maxExecutions: row.max_executions, attempts: db.prepare('SELECT * FROM execution_attempts WHERE run_id=? ORDER BY reserved_at,token').all(id).map(attempt => ({ ...attempt, state: String(attempt.state), token: String(attempt.token), requestId: String(attempt.request_id), executionProvenance: attempt.provenance ? JSON.parse(String(attempt.provenance)) as ExecutionProvenance : null })) } : null; },
    acquire,
    admission(repo: string, repoCap?: number): Admission { return { acquire: (request, options) => acquire({ ...request, repo, repoCap }, options) }; },
    close() { if (closed) return; closed = true; db.close(); },
  };
}
