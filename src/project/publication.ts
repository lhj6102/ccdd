import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ownerAlive } from '../broker/ownership.js';

/** Whether a cache-owned execution's verdict became shared evidence. */
export interface ExecutionPublication {
  state: 'accepted' | 'pending' | 'rejected';
  code?: string; message?: string;
}

const unavailable: ExecutionPublication = { state: 'pending', code: 'PUBLICATION_UNAVAILABLE', message: 'Publication could not be established from the identity cache; this verdict is audit only.' };

/**
 * The cache job is the publication authority, not the execution's reviewer verdict.
 * Terminal jobs survive as long as their execution audit does, including across crashes.
 * Resolve the cache next to this store, never from the reader's current state home.
 */
export function executionPublication(database: DatabaseSync): ExecutionPublication | null {
  const registered = database.prepare("SELECT value FROM metadata WHERE key='registered-repo'").get();
  if (!registered || (JSON.parse(String(registered.value)) as { repoId?: unknown }).repoId !== 'cache-execution') return null;
  const run = database.prepare("SELECT id FROM runs WHERE json_extract(data,'$.executionOwned')=1 LIMIT 1").get();
  if (!run) return null;
  const executionId = String(run.id), store = dirname(database.location() ?? '');
  const cacheFile = join(dirname(dirname(store)), 'cache.sqlite');
  if (basename(store) !== executionId || basename(dirname(store)) !== 'executions' || !existsSync(cacheFile)) return unavailable;
  let cache: DatabaseSync | undefined;
  try {
    cache = new DatabaseSync(cacheFile, { readOnly: true, timeout: 5000 });
    const job = cache.prepare('SELECT state,error_code,error_message,pid,process_identity FROM cache_jobs WHERE id=?').get(executionId);
    if (job?.state === 'COMPLETED') return { state: 'accepted' };
    if (job?.state === 'ERROR') return { state: 'rejected', code: String(job.error_code), message: String(job.error_message) };
    if (job?.state === 'RUNNING') {
      // A crashed owner can never publish; GC records the same outcome when it next runs.
      return ownerAlive({ run_id: '', token: '', claimed_at: '', pid: Number(job.pid), process_identity: job.process_identity as string | null }) ? { state: 'pending' }
        : { state: 'rejected', code: 'COMPUTE_OWNER_EXITED', message: 'Shared computation owner exited before publication.' };
    }
    // A published job may already be removed; its retained entry still names this execution.
    return cache.prepare("SELECT 1 FROM cache_entries WHERE json_extract(data,'$.executionId')=? LIMIT 1").get(executionId) ? { state: 'accepted' } : unavailable;
  } catch { return unavailable; }
  finally { cache?.close(); }
}
