import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openIdentityCache, type CachedReview } from '../src/cache/index.js';

const value = (): CachedReview => ({ result: { verdict: 'GREEN' }, profile: { kind: 'human' },
  origin: { runId: 'fixture', requestId: 'fixture' }, attemptId: null, executionProvenance: null });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-cache-maintenance-'));
  const cache = openIdentityCache({ directory: join(root, 'cache') });
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cache };
}

test('opening an initialized WAL cache never takes a writer lock', async t => {
  const { cache } = await fixture(t), blocker = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  try {
    const start = performance.now();
    const reader = openIdentityCache({ directory: cache.directory });
    assert.ok(performance.now() - start < 500);
    blocker.exec('ROLLBACK');
    await reader.close();
  } finally { blocker.close(); }
});

test('explicit GC honors recent admitted hits before choosing LRU entries', async t => {
  const { cache } = await fixture(t);
  await cache.compute('older', async () => value());
  await cache.compute('newer', async () => value());
  const db = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  db.exec("UPDATE cache_entries SET accessed_at=CASE identity WHEN 'older' THEN 1 ELSE 2 END");
  cache.noteUsed(['older']);
  await cache.close();
  const limited = openIdentityCache({ directory: cache.directory, maxEntries: 1 });
  try {
    await limited.gc();
    assert.ok(limited.get('older')); assert.equal(limited.get('newer'), null);
  } finally { await limited.close(); db.close(); }
});

test('an unrelated GC retirement failure cannot withhold a completed result or delete external files', async t => {
  const { root, cache } = await fixture(t), external = join(root, 'external');
  await mkdir(external); await writeFile(join(external, 'keep'), 'untouched');
  await symlink(external, join(cache.directory, 'executions'));
  const db = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  try { db.prepare('INSERT INTO cache_execution_storage(id) VALUES(?)').run(randomUUID()); } finally { db.close(); }
  const result = await cache.compute('valid', async () => value());
  assert.equal(result.entry.value.result.verdict, 'GREEN');
  await assert.rejects(cache.gc(), { code: 'CACHE_STORAGE_UNSAFE' });
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'untouched');
});

test('publication contention cannot strand a RUNNING job owned by a live process', { timeout: 25000 }, async t => {
  const { cache } = await fixture(t), blocker = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  const abort = new AbortController();
  let release: (() => void) | undefined, calls = 0;
  const executing = new Promise<void>(resolve => { release = resolve; });
  const result = cache.compute('contended', async () => {
    calls++; blocker.exec('BEGIN IMMEDIATE'); release!(); return value();
  }, { signal: abort.signal });
  const rejected = assert.rejects(result, { code: 'CACHE_BUSY' });
  await executing;
  // Hold longer than both bounded terminal-write attempts. WAL readers still run.
  await delay(11500); blocker.exec('ROLLBACK'); blocker.close();
  try {
    await rejected;
    const deadline = performance.now() + 5000;
    while (cache.active('contended')) {
      assert.ok(performance.now() < deadline, 'Failed live-owner jobs must publish a terminal state after contention clears.');
      await delay(25);
    }
    const recovered = await cache.compute('contended', async () => { calls++; return value(); });
    assert.equal(recovered.entry.value.result.verdict, 'GREEN'); assert.equal(calls, 2);
  } finally { abort.abort(); }
});
