import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerAlive, ownProcessIdentity } from '../broker/ownership.js';
import type { CriticProfile, ReviewResult, ReviewRequest } from '../contracts.js';
import type { ExecutionProvenance } from '../provenance.js';

/** Identity is opaque. These are encoding bounds, not inferred semantic inputs. */
export function validateCacheIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[^A-Za-z0-9._:-]/.test(value)) {
    throw new Error('Cache identity must contain 1-128 characters from [A-Za-z0-9._:-].');
  }
}
export const identityCacheDirectory = () => join(process.env.CCDD_STATE_HOME || join(homedir(), '.local', 'state', 'ccdd'), 'identity-cache');
export interface CachedReview {
  result: ReviewResult;
  profile: CriticProfile;
  origin: { runId: string; requestId: string; stateDir?: string };
  definition?: { criticId: string; payload: unknown; passSchema?: unknown; failSchema?: unknown; resultCheck?: unknown };
  /** Diagnostic attempt summary; never used to decide reuse. */
  summary?: { toolCalls: Record<string, number>; executorStarts: number; wallMs: number };
  attemptId: string | null;
  executionProvenance: ExecutionProvenance | null;
  usage?: ReviewRequest['usage'];
}
export interface CacheEntry {
  identity: string | null;
  executionId: string;
  completedAt: string;
  value: CachedReview;
  digest: string;
}
export interface CacheOptions { directory?: string; maxBytes?: number; maxEntries?: number; maxEntryBytes?: number }
export interface CacheComputeOptions {
  signal?: AbortSignal;
  /** Bypass reuse for this call only; never replace another caller's shared result. */
  force?: boolean;
  /** Scope is diagnostic/lifetime metadata, never a cache partition. */
  scope?: string;
  onState?: (state: 'executing' | 'coalesced' | 'hit', executionId: string) => void;
}
export interface CacheComputation { entry: CacheEntry; disposition: 'executed' | 'coalesced' | 'hit' | 'uncached' }
type Owner = { pid: number; process_identity: string | null };
const alive = (owner: Owner) => ownerAlive({ ...owner, run_id: '', token: '', claimed_at: '' });
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const busy = (error: unknown) => !!error && typeof error === 'object' && ((Number((error as { errcode?: number }).errcode) & 255) === 5 || (error as { code?: string }).code === 'SQLITE_BUSY');
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const format = (db: DatabaseSync) => {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 1 || Number(db.prepare('PRAGMA application_id').get()!.application_id) !== 1128481859) throw error('CACHE_FORMAT_UNSUPPORTED', 'Unsupported identity cache format; do not relabel or import legacy project keys.');
};
function decode(row: Record<string, any> | undefined): CacheEntry | null {
  if (!row) return null;
  if (typeof row.data !== 'string' || digest(row.data) !== row.digest) throw error('CACHE_CORRUPT', 'Cached result integrity check failed.');
  const entry = JSON.parse(row.data) as Omit<CacheEntry, 'digest'>;
  if (!entry || !entry.value || !['GREEN', 'RED'].includes(entry.value.result?.verdict) || typeof entry.executionId !== 'string' || typeof entry.completedAt !== 'string' || entry.identity !== row.identity) throw error('CACHE_CORRUPT', 'Invalid cached result record.');
  return { ...entry, digest: String(row.digest) };
}
function encoded(identity: string | null, executionId: string, value: CachedReview) {
  if (!value || !['GREEN', 'RED'].includes(value.result?.verdict)) throw error('CACHE_RESULT_INVALID', 'Only actual completed GREEN or RED results may be cached.');
  const data = JSON.stringify({ identity, executionId, completedAt: new Date().toISOString(), value });
  return { identity, data, digest: digest(data), bytes: Buffer.byteLength(data) };
}

/** Read-only, repository-independent lookup. Merely querying does not create state or touch LRU metadata. */
export function readIdentityCache(identity: string, directory = identityCacheDirectory()): CacheEntry | null {
  validateCacheIdentity(identity);
  const filename = join(directory, 'cache.sqlite');
  if (!existsSync(filename)) return null;
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try { format(db); return decode(db.prepare('SELECT identity,data,digest FROM cache_entries WHERE identity=?').get(identity)); }
  finally { db.close(); }
}

/** Read only the selected identities in one SQLite snapshot; missing stores remain absent. */
export function readIdentityEntries(identities: Iterable<string>, directory = identityCacheDirectory()): Map<string, CacheEntry> {
  const keys = [...new Set(identities)]; for (const key of keys) validateCacheIdentity(key);
  const result = new Map<string, CacheEntry>(), filename = join(directory, 'cache.sqlite');
  if (!keys.length || !existsSync(filename)) return result;
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN'); format(db);
    const read = db.prepare('SELECT identity,data,digest FROM cache_entries WHERE identity=?');
    for (const key of keys) { const entry = decode(read.get(key)); if (entry) result.set(key, entry); }
    db.exec('COMMIT'); return result;
  } finally { db.close(); }
}

export function readActiveIdentities(identities: Iterable<string>, directory = identityCacheDirectory()): Map<string, string> {
  const keys = [...new Set(identities)]; for (const key of keys) validateCacheIdentity(key);
  const result = new Map<string, string>(), filename = join(directory, 'cache.sqlite');
  if (!keys.length || !existsSync(filename)) return result;
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN'); format(db);
    const statement = db.prepare("SELECT j.id,j.pid,j.process_identity FROM cache_active a JOIN cache_jobs j ON j.id=a.job_id WHERE a.identity=? AND j.state='RUNNING'");
    for (const key of keys) { const row = statement.get(key); if (row && alive(row as unknown as Owner)) result.set(key, String(row.id)); }
    db.exec('COMMIT'); return result;
  } finally { db.close(); }
}

/**
 * One local trust domain, no repository registration. Job ownership and subscribers
 * are operational records, not alternative identity keys. Complete values own all
 * their JSON/embedded bytes; reading them never opens their original repository.
 */
export function openIdentityCache({ directory = identityCacheDirectory(), maxBytes = 1024 ** 3, maxEntries = 10000, maxEntryBytes = 16 * 1024 ** 2 }: CacheOptions = {}) {
  directory = resolve(directory);
  for (const [name, value] of Object.entries({ maxBytes, maxEntries, maxEntryBytes })) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'cache.sqlite'), { timeout: 5000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version === 0) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw error('CACHE_FORMAT_UNSUPPORTED', 'An unrelated database cannot be initialized as an identity cache.');
      db.exec(`
        CREATE TABLE cache_entries(identity TEXT PRIMARY KEY,data TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,accessed_at INTEGER NOT NULL);
        CREATE INDEX cache_lru ON cache_entries(accessed_at,identity);
        CREATE TABLE cache_totals(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL,count INTEGER NOT NULL);
        INSERT INTO cache_totals VALUES(1,0,0);
        CREATE TRIGGER cache_added AFTER INSERT ON cache_entries BEGIN UPDATE cache_totals SET bytes=bytes+new.bytes,count=count+1 WHERE id=1; END;
        CREATE TRIGGER cache_removed AFTER DELETE ON cache_entries BEGIN UPDATE cache_totals SET bytes=bytes-old.bytes,count=count-1 WHERE id=1; END;
        CREATE TRIGGER cache_resized AFTER UPDATE OF bytes ON cache_entries BEGIN UPDATE cache_totals SET bytes=bytes+new.bytes-old.bytes WHERE id=1; END;
        CREATE TABLE cache_jobs(id TEXT PRIMARY KEY,identity TEXT NOT NULL,pid INTEGER NOT NULL,process_identity TEXT,state TEXT NOT NULL,data TEXT,digest TEXT,error_code TEXT,error_message TEXT,created_at INTEGER NOT NULL);
        CREATE TABLE cache_active(identity TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL);
        CREATE TABLE cache_subscribers(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,pid INTEGER NOT NULL,process_identity TEXT);
        CREATE INDEX cache_job_subscribers ON cache_subscribers(job_id);
        CREATE INDEX cache_subscriber_owner ON cache_subscribers(pid,process_identity);
        PRAGMA user_version=1; PRAGMA application_id=1128481859;
      `);
    }
    format(db);
    db.exec(`CREATE TABLE IF NOT EXISTS cache_execution_storage(id TEXT PRIMARY KEY,retire_pid INTEGER,retire_identity TEXT);
      CREATE INDEX IF NOT EXISTS cache_entry_execution ON cache_entries(json_extract(data,'$.executionId'));`);
    db.exec('COMMIT'); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=25');
    chmodSync(join(directory, 'cache.sqlite'), 0o600);
  } catch (cause) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw cause; }
  let closed = false, closing = false;
  const owned = new Map<string, { controller: AbortController; promise: Promise<void>; scope?: string }>();
  const subscribers = new Set<string>();
  const shuttingDown = new AbortController();
  const clients = new Set<Promise<CacheComputation>>();
  const touches = new Map<string, number>();
  let maintenance: NodeJS.Timeout | undefined;
  let maintaining = false, lastReap = 0;
  const assertOpen = () => { if (closed || closing) throw new Error('Identity cache is closed.'); };
  const transaction = <T>(fn: () => T): T => {
    let began = false;
    try { db.exec('BEGIN IMMEDIATE'); began = true; const value = fn(); db.exec('COMMIT'); return value; }
    catch (cause) { if (began) { try { db.exec('ROLLBACK'); } catch {} } throw cause; }
  };
  const retry = async <T>(fn: () => T, signal?: AbortSignal): Promise<T> => {
    const deadline = performance.now() + 5000; let pause = 10;
    for (;;) {
      signal?.throwIfAborted();
      try { return fn(); }
      catch (cause) { if (!busy(cause)) throw cause; if (performance.now() >= deadline) throw error('CACHE_BUSY', 'Identity cache is busy; retry the operation.'); }
      await delay(Math.min(pause, Math.max(1, deadline - performance.now())) + Math.floor(Math.random() * 10), undefined, { signal }); pause = Math.min(200, pause * 2);
    }
  };
  const lookup = (identity: string) => decode(db.prepare('SELECT identity,data,digest FROM cache_entries WHERE identity=?').get(identity));
  const reapSubscribers = () => {
    const owners = db.prepare('SELECT DISTINCT pid,process_identity FROM cache_subscribers LIMIT 256').all() as unknown as Owner[];
    const dead = owners.filter(owner => !alive(owner));
    if (dead.length) transaction(() => { for (const owner of dead) db.prepare('DELETE FROM cache_subscribers WHERE pid=? AND process_identity IS ?').run(owner.pid, owner.process_identity); });
  };
  const removeJob = (jobId: string) => {
    db.prepare("DELETE FROM cache_jobs WHERE id=? AND state!='RUNNING' AND NOT EXISTS(SELECT 1 FROM cache_subscribers WHERE job_id=?)").run(jobId, jobId);
  };
  const maintain = async () => {
    if (closed || maintaining) return;
    maintaining = true;
    try {
      if (performance.now() - lastReap > 1000) { await retry(reapSubscribers); lastReap = performance.now(); }
      for (const [id, task] of owned) {
        const row = db.prepare('SELECT state FROM cache_jobs WHERE id=?').get(id);
        if (row?.state !== 'RUNNING') task.controller.abort(error('CACHE_OWNERSHIP_LOST', 'Shared computation ownership was lost.'));
        else if (!db.prepare('SELECT 1 FROM cache_subscribers WHERE job_id=? LIMIT 1').get(id)) task.controller.abort(error('ABORTED', 'All subscribers canceled the shared computation.'));
      }
      if (touches.size) {
        const batch = [...touches].slice(0, 128);
        await retry(() => transaction(() => { for (const [identity, at] of batch) db.prepare('UPDATE cache_entries SET accessed_at=MAX(accessed_at,?) WHERE identity=?').run(at, identity); }));
        for (const [identity, at] of batch) if (touches.get(identity) === at) touches.delete(identity);
      }
    } finally { maintaining = false; }
  };
  const startMaintenance = () => { maintenance ??= setInterval(() => { void maintain().catch(() => { /* A live owner is never stolen merely for delayed bookkeeping. */ }); }, 100); };
  const touch = (identity: string) => { if (touches.size < 4096) touches.set(identity, Date.now()); startMaintenance(); };
  const retireStorage = async (limit: number) => {
    const candidates = await retry(() => transaction(() => {
      const rows = db.prepare(`SELECT * FROM cache_execution_storage s WHERE
        NOT EXISTS(SELECT 1 FROM cache_jobs WHERE id=s.id) AND
        NOT EXISTS(SELECT 1 FROM cache_entries WHERE json_extract(data,'$.executionId')=s.id) LIMIT ?`).all(limit);
      return rows.filter(row => {
        if (row.retire_pid != null && alive({pid: Number(row.retire_pid), process_identity: row.retire_identity as string | null})) return false;
        db.prepare('UPDATE cache_execution_storage SET retire_pid=?,retire_identity=? WHERE id=?').run(process.pid,ownProcessIdentity,row.id);
        return true;
      });
    }));
    for (const row of candidates) {
      // Only cache-generated UUID paths can be removed. Rename before walking;
      // do not hold a SQLite writer while deleting possibly large output trees.
      const id = String(row.id);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) continue;
      const root = join(directory, 'executions'), target = join(root,id), quarantine = join(root,`.gc-${id}`);
      try {
        const parent = await lstat(root).catch(cause => { if(cause.code==='ENOENT') return null; throw cause; });
        if (parent?.isSymbolicLink()) throw error('CACHE_STORAGE_UNSAFE','Cache execution storage cannot be a symbolic link.');
        const current = await lstat(target).catch(cause => { if(cause.code==='ENOENT') return null; throw cause; });
        if (current) {
          if (!current.isDirectory() || current.isSymbolicLink()) throw error('CACHE_STORAGE_UNSAFE','Unexpected cache execution storage.');
          await rename(target,quarantine);
        }
        await rm(quarantine,{recursive:true,force:true});
        await retry(() => db.prepare('DELETE FROM cache_execution_storage WHERE id=? AND retire_pid=? AND retire_identity IS ?').run(id,process.pid,ownProcessIdentity));
      } catch (cause) {
        await retry(() => db.prepare('UPDATE cache_execution_storage SET retire_pid=NULL,retire_identity=NULL WHERE id=? AND retire_pid=? AND retire_identity IS ?').run(id,process.pid,ownProcessIdentity));
        throw cause;
      }
    }
  };
  const gc = async ({ limit = 128 }: { limit?: number } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('GC limit must be 1-1000.');
    await retry(reapSubscribers);
    const result = await retry(() => transaction(() => {
      const jobs = db.prepare("SELECT id,identity,pid,process_identity FROM cache_jobs WHERE state='RUNNING' ORDER BY created_at LIMIT ?").all(limit);
      for (const job of jobs) if (!alive(job as unknown as Owner)) {
        db.prepare("UPDATE cache_jobs SET state='ERROR',error_code='COMPUTE_OWNER_EXITED',error_message='Shared computation owner exited.' WHERE id=? AND state='RUNNING'").run(job.id);
        db.prepare('DELETE FROM cache_active WHERE identity=? AND job_id=?').run(job.identity, job.id);
      }
      let { bytes, count } = db.prepare('SELECT bytes,count FROM cache_totals WHERE id=1').get() as { bytes: number; count: number };
      let removed = 0;
      if (bytes > maxBytes || count > maxEntries) {
        const candidates = db.prepare(`SELECT identity,bytes FROM cache_entries e WHERE NOT EXISTS(
          SELECT 1 FROM cache_jobs j JOIN cache_subscribers s ON s.job_id=j.id WHERE j.identity=e.identity
        ) ORDER BY accessed_at,identity LIMIT ?`).all(limit);
        for (const row of candidates) {
          if (bytes <= maxBytes && count <= maxEntries) break;
          db.prepare('DELETE FROM cache_entries WHERE identity=?').run(row.identity); bytes -= Number(row.bytes); count--; removed++;
        }
      }
      const deadJobs = db.prepare("SELECT id FROM cache_jobs j WHERE state!='RUNNING' AND NOT EXISTS(SELECT 1 FROM cache_subscribers WHERE job_id=j.id) LIMIT ?").all(limit);
      for (const row of deadJobs) removeJob(String(row.id));
      return { removed, bytes: Number(bytes), entries: Number(count), needsMore: bytes > maxBytes || count > maxEntries };
    }));
    await retireStorage(limit);
    return result;
  };
  const start = (jobId: string, identity: string, execute: (signal: AbortSignal, executionId: string) => Promise<CachedReview>, scope?: string) => {
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const value = await execute(controller.signal, jobId);
        controller.signal.throwIfAborted();
        const row = encoded(identity, jobId, value);
        await retry(() => transaction(() => {
          controller.signal.throwIfAborted();
          const job = db.prepare("SELECT pid,process_identity FROM cache_jobs WHERE id=? AND state='RUNNING'").get(jobId);
          if (!job || job.pid !== process.pid || job.process_identity !== ownProcessIdentity || db.prepare('SELECT job_id FROM cache_active WHERE identity=?').get(identity)?.job_id !== jobId) throw error('CACHE_OWNERSHIP_LOST', 'Shared computation ownership was lost before publication.');
          if (!db.prepare('SELECT 1 FROM cache_subscribers WHERE job_id=? LIMIT 1').get(jobId)) throw error('ABORTED', 'The shared computation has no remaining subscriber.');
          if (row.bytes <= maxEntryBytes && row.bytes <= maxBytes) db.prepare('INSERT INTO cache_entries VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data,digest=excluded.digest,bytes=excluded.bytes,created_at=excluded.created_at,accessed_at=excluded.accessed_at').run(identity, row.data, row.digest, row.bytes, Date.now(), Date.now());
          db.prepare("UPDATE cache_jobs SET state='COMPLETED',data=?,digest=? WHERE id=?").run(row.data, row.digest, jobId);
          db.prepare('DELETE FROM cache_active WHERE identity=? AND job_id=?').run(identity, jobId);
        }));
      } catch (cause) {
        // Operational errors are visible only to this attempt's subscribers. They
        // never become identity->result entries or negative-cache future requests.
        const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code) ? cause.code : 'COMPUTE_FAILED';
        const message = 'Shared computation failed; inspect the original execution diagnostics.';
        await retry(() => transaction(() => {
          db.prepare("UPDATE cache_jobs SET state='ERROR',error_code=?,error_message=? WHERE id=? AND pid=? AND process_identity IS ? AND state='RUNNING'").run(code, message, jobId, process.pid, ownProcessIdentity);
          db.prepare('DELETE FROM cache_active WHERE identity=? AND job_id=?').run(identity, jobId);
        }));
      } finally {
        owned.delete(jobId);
        await retry(() => removeJob(jobId));
        await gc();
      }
    })();
    // Execute is asynchronous; install the owner before its first continuation.
    owned.set(jobId, { controller, promise, scope });
    void promise.catch(() => { /* Subscribers observe the persisted outcome or owner liveness. */ });
    startMaintenance();
  };
  const detach = async (subscriber: string, jobId: string) => {
    subscribers.delete(subscriber);
    await retry(() => transaction(() => { db.prepare('DELETE FROM cache_subscribers WHERE id=?').run(subscriber); removeJob(jobId); }));
    await maintain();
    await gc();
  };
  const compute = async (identity: string | null | undefined, execute: (signal: AbortSignal, executionId: string) => Promise<CachedReview>, options: CacheComputeOptions = {}): Promise<CacheComputation> => {
      assertOpen();
      options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, shuttingDown.signal]) : shuttingDown.signal };
      options.signal!.throwIfAborted();
      if (identity != null) validateCacheIdentity(identity);
      if (identity == null || options.force) {
        const executionId = randomUUID(), signal = options.signal ?? new AbortController().signal;
        options.onState?.('executing', executionId);
        const value = await execute(signal, executionId); signal.throwIfAborted();
        return { entry: decode(encoded(null, executionId, value))!, disposition: 'uncached' };
      }
      validateCacheIdentity(identity);
      const hit = options.force ? null : await retry(() => lookup(identity), options.signal);
      if (hit) { touch(identity); options.onState?.('hit', hit.executionId); return { entry: hit, disposition: 'hit' }; }
      const subscriber = randomUUID(); let jobId = '', creator = false;
      try {
        for (;;) {
          const attached = await retry(() => transaction(() => {
            const hit = options.force ? null : lookup(identity!); if (hit) return { hit };
            let job = db.prepare("SELECT j.* FROM cache_active a JOIN cache_jobs j ON j.id=a.job_id WHERE a.identity=? AND j.state='RUNNING'").get(identity!);
            if (job && !alive(job as unknown as Owner)) {
              db.prepare("UPDATE cache_jobs SET state='ERROR',error_code='COMPUTE_OWNER_EXITED',error_message='Shared computation owner exited.' WHERE id=? AND state='RUNNING'").run(job.id);
              db.prepare('DELETE FROM cache_active WHERE identity=? AND job_id=?').run(identity!, job.id); job = undefined;
            }
            if (job && options.force) return { wait: true as const };
            let own = false;
            if (!job) {
              const id = randomUUID();
              db.prepare("INSERT INTO cache_jobs(id,identity,pid,process_identity,state,created_at) VALUES(?,?,?,?,'RUNNING',?)").run(id, identity!, process.pid, ownProcessIdentity, Date.now());
              db.prepare('INSERT INTO cache_active VALUES(?,?)').run(identity!, id);
              db.prepare('INSERT INTO cache_execution_storage(id) VALUES(?)').run(id); job = { id }; own = true;
            }
            db.prepare('INSERT OR REPLACE INTO cache_subscribers VALUES(?,?,?,?)').run(subscriber, job.id, process.pid, ownProcessIdentity);
            return { jobId: String(job.id), own };
          }), options.signal);
          if ('wait' in attached) { await delay(50, undefined, { signal: options.signal }); continue; }
          if ('hit' in attached && attached.hit) { touch(identity); options.onState?.('hit', attached.hit.executionId); return { entry: attached.hit, disposition: 'hit' }; }
          jobId = attached.jobId!; creator = Boolean(attached.own); subscribers.add(subscriber);
          if (creator) start(jobId, identity, execute, options.scope);
          options.onState?.(creator ? 'executing' : 'coalesced', jobId);
          for (;;) {
            options.signal?.throwIfAborted();
            const row = await retry(() => db.prepare('SELECT * FROM cache_jobs WHERE id=?').get(jobId), options.signal);
            if (!row) throw error('CACHE_JOB_LOST', 'Shared computation record disappeared.');
            if (row.state === 'COMPLETED') return { entry: decode(row)!, disposition: creator ? 'executed' : 'coalesced' };
            if (row.state === 'ERROR') {
              if (row.error_code === 'COMPUTE_OWNER_EXITED') { await detach(subscriber, jobId); break; }
              throw error(String(row.error_code), String(row.error_message));
            }
            if (!alive(row as unknown as Owner)) { await detach(subscriber, jobId); break; }
            await delay(50, undefined, { signal: options.signal });
          }
        }
      } catch (cause) { throw options.signal?.aborted ? options.signal.reason : cause; }
      finally {
        if (jobId && subscribers.has(subscriber)) {
          try { await detach(subscriber, jobId); }
          catch (cause) { if (!options.signal?.aborted) throw cause; }
        }
      }
  };
  return {
    directory,
    get(identity: string) { assertOpen(); validateCacheIdentity(identity); return lookup(identity); },
    list({ after = '', limit = 100 }: { after?: string; limit?: number } = {}) {
      assertOpen(); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Cache page limit must be 1-1000.');
      const rows = db.prepare('SELECT identity,bytes,created_at,accessed_at FROM cache_entries WHERE identity>? ORDER BY identity LIMIT ?').all(after, limit + 1);
      const items = rows.slice(0, limit); return { items, cursor: String(items.at(-1)?.identity ?? after), hasMore: rows.length > limit };
    },
    active(identity: string) {
      assertOpen(); validateCacheIdentity(identity);
      const row = db.prepare("SELECT j.id,j.pid,j.process_identity FROM cache_active a JOIN cache_jobs j ON j.id=a.job_id WHERE a.identity=? AND j.state='RUNNING'").get(identity);
      return row && alive(row as unknown as Owner) ? { executionId: String(row.id) } : null;
    },
    compute(identity: string | null | undefined, execute: (signal: AbortSignal, executionId: string) => Promise<CachedReview>, options: CacheComputeOptions = {}) {
      const pending = compute(identity, execute, options); clients.add(pending);
      void pending.then(() => clients.delete(pending), () => clients.delete(pending));
      return pending;
    },
    async delete(identity: string) {
      assertOpen(); validateCacheIdentity(identity);
      return retry(() => transaction(() => {
        if (db.prepare('SELECT 1 FROM cache_active WHERE identity=?').get(identity) || db.prepare('SELECT 1 FROM cache_jobs j JOIN cache_subscribers s ON s.job_id=j.id WHERE j.identity=? LIMIT 1').get(identity)) throw error('CACHE_IN_USE', 'Cannot delete an identity with active computation or subscribers.');
        return Number(db.prepare('DELETE FROM cache_entries WHERE identity=?').run(identity).changes);
      }));
    },
    gc,
    async drain(scope?: string) { await Promise.allSettled([...owned.values()].filter(task => scope === undefined || task.scope === scope).map(task => task.promise)); },
    async close() {
      if (closed) return; closing = true;
      shuttingDown.abort(error('CACHE_CLOSED', 'Identity cache closed.'));
      await Promise.allSettled([...clients]);
      // Local subscriptions are detached first. Remote subscribers
      // keep the computation alive while the owner gracefully drains.
      await Promise.allSettled([...owned.values()].map(task => task.promise));
      clearInterval(maintenance);
      while (maintaining) await delay(5);
      await maintain();
      db.close(); closed = true;
    },
  };
}
export type IdentityCache = ReturnType<typeof openIdentityCache>;
