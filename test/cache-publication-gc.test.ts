import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openIdentityCache, type CachedReview } from '../src/cache/index.js';

test('terminal publication jobs stay bounded by retained evidence and audit GC removes rejected and oversized jobs', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccdd-gc-publication-'));
  const cache = openIdentityCache({ directory: root, maxEntries: 4, maxBytes: 16384, maxEntryBytes: 4096 });
  const db = new DatabaseSync(join(root, 'cache.sqlite'));
  t.after(async () => { await cache.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const value = (answer: string): CachedReview => ({ result: { verdict: 'GREEN', answer }, profile: { kind: 'human' }, origin: { runId: 'review', requestId: 'review' }, attemptId: null, executionProvenance: null });
  for (let i = 0; i < 24; i++) {
    const execute = async (_signal: AbortSignal, id: string) => { await fs.mkdir(join(root, 'executions', id), { recursive: true }); return value(i % 3 === 0 ? 'x'.repeat(5000) : 'accepted'); };
    if (i % 3 === 1) await assert.rejects(cache.compute(`key-${i}`, execute, { accept: async () => { throw Object.assign(new Error('Controlled rejection'), { code: 'WORKSPACE_CHANGED' }); } }), { code: 'WORKSPACE_CHANGED' });
    else await cache.compute(`key-${i}`, execute);
  }
  await cache.drain();
  let more = true, passes = 0;
  while (more) { assert.ok(passes++ < 30, 'GC must converge rather than retain a terminal-job backlog'); more = (await cache.gc({ limit: 3 })).needsMore; }
  const entries = Number(db.prepare('SELECT count(*) AS n FROM cache_entries').get()!.n);
  assert.ok(entries <= 4);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM cache_jobs').get()!.n), entries);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM cache_execution_storage').get()!.n), entries);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM cache_jobs WHERE state!='COMPLETED'").get()!.n), 0);
  assert.equal((await fs.readdir(join(root, 'executions'))).length, entries);
});
