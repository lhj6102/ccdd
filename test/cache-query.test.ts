import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openIdentityCache, type CachedReview } from '../src/cache/index.js';
import { listIdentityCache, cachedResultView, compareIdentityCache } from '../src/cache/query.js';
import { main } from '../src/project/cli.js';
const value: CachedReview = { result: { verdict: 'RED', reasons: ['controlled reason'], toolCalls: [] }, profile: { kind: 'human' }, origin: { runId: 'run', requestId: 'request' }, attemptId: null, executionProvenance: null };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-cache-query-')); const cache = openIdentityCache({ directory: join(root, 'cache') });
  t.after(async () => { await cache.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cache };
}
test('read-only cache listing and CLI misses do not create cache state or require a project', async t => {
  const { root } = await fixture(t), directory = join(root, 'missing');
  assert.deepEqual(listIdentityCache({ directory }), { items: [], cursor: '', hasMore: false });
  let out = ''; const io = { stdout: { write(text: string) { out += text; } } };
  assert.equal(await main(['cache', 'show', 'missing', '--cache-dir', directory, '--json'], io), 4);
  assert.equal(JSON.parse(out), null); await assert.rejects(access(directory));
});
test('cache queries retain owner results and original attribution without touching LRU state', async t => {
  const { cache } = await fixture(t);
  for (const id of ['a', 'b', 'c']) await cache.compute(id, async () => value);
  const before = listIdentityCache({ directory: cache.directory });
  const page = listIdentityCache({ directory: cache.directory, limit: 2 });
  assert.deepEqual(page.items.map(item => item.identity), ['a', 'b']); assert.equal(page.hasMore, true);
  assert.deepEqual(listIdentityCache({ directory: cache.directory, after: page.cursor }).items.map(item => item.identity), ['c']);
  const view = cachedResultView(cache.get('a')!); assert.equal(view.usageState, 'unreported');
  assert.deepEqual(view.result, { verdict: 'RED', reasons: ['controlled reason'] });
  view.profile.kind = 'runtime'; assert.equal(cache.get('a')!.value.profile.kind, 'human');
  assert.deepEqual(listIdentityCache({ directory: cache.directory }), before);
  assert.equal(compareIdentityCache('a', 'b', cache.directory).differences?.result, false);
  assert.equal(compareIdentityCache('a', 'missing', cache.directory).differences, null);
});
test('cache CLI comparison and explicit deletion are independent of workspace registration', async t => {
  const { cache } = await fixture(t);
  await cache.compute('a', async () => value);
  await cache.compute('b', async () => ({ ...value, result: { verdict: 'GREEN', toolCalls: [] } }));
  let out = '', err = ''; const io = { stdout: { write(s: string) { out += s; } }, stderr: { write(s: string) { err += s; } } };
  assert.equal(await main(['cache', 'compare', 'a', 'b', '--cache-dir', cache.directory, '--json'], io), 0, err);
  assert.equal(JSON.parse(out).differences.result, true);
  out = ''; assert.equal(await main(['cache', 'delete', 'a', '--cache-dir', cache.directory, '--json'], io), 0, err);
  assert.equal(JSON.parse(out).removed, 1); assert.equal(cache.get('a'), null);
  const db = new DatabaseSync(join(cache.directory, 'cache.sqlite'));
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='registered-repo'").get()!.n, 0); } finally { db.close(); }
});
