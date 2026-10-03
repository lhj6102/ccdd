import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { openIdentityCache, type CachedReview } from '../src/cache/index.js';

const value: CachedReview = { result: { verdict: 'GREEN' }, profile: { kind: 'runtime', command: 'node', args: ['--version'], timeoutMs: 5000 },
  origin: { runId: 'controlled', requestId: 'controlled' }, attemptId: 'controlled', executionProvenance: null };

test('a fenced local subscriber must wake even when the original executor has not settled', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-cache-wakeup-'));
  const cache = openIdentityCache({ directory: join(root, 'cache') });
  const writer = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await cache.drain(); await cache.close(); writer.close(); await rm(root, { recursive: true, force: true }); });
  // Prime maintenance so it can detect a terminal row without a subscriber-reaping await.
  await cache.gc();
  let abortObserved = false, maintained!: () => void, maintenanceFailed!: (error: unknown) => void;
  const maintenance = new Promise<void>((resolve, reject) => { maintained = resolve; maintenanceFailed = reject; });
  const original = cache.compute('fenced-local', async signal => {
    signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
    await gate; return value;
  }, {
    onState(state) {
      if (state !== 'executing') return;
      // This lands after compute SELECTs RUNNING but before its await continuation.
      // The stored terminal outcome and maintenance wake are already authoritative;
      // returning them must not depend on a canceled executor acknowledging abort.
      queueMicrotask(() => {
        writer.exec("BEGIN IMMEDIATE; UPDATE cache_jobs SET state='ERROR',error_code='CACHE_OWNERSHIP_LOST',error_message='controlled fencing' WHERE identity='fenced-local'; DELETE FROM cache_active WHERE identity='fenced-local'; COMMIT");
        void cache.gc().then(() => maintained(), maintenanceFailed);
      });
    },
  });
  const outcome = original.then(() => 'unexpected-result', error => (error as { code?: string }).code);
  await maintenance;
  assert.equal(abortObserved, true, 'maintenance has already aborted the original owner');
  assert.equal(writer.prepare("SELECT state FROM cache_jobs WHERE identity='fenced-local'").get()!.state, 'ERROR');
  const first = await Promise.race([outcome, delay(500).then(() => 'STILL_WAITING_FOR_EXECUTOR')]);
  assert.equal(first, 'CACHE_OWNERSHIP_LOST', 'a persisted terminal row must wake a subscriber without waiting for the fenced executor');
});
