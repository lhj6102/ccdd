import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';
import { prepareReviewRequests } from '../src/requester/index.js';
import { createReviewTools } from '../src/tools/runner.js';
import { createProjectSnapshot } from '../src/project/identity.js';
import { createBroker } from '../src/broker/index.js';
import { projectRun, projectRuns } from '../src/project/store.js';
import type { ReviewEnvelope } from '../src/contracts.js';

const critic = { id: 'check', title: 'Check', profile: agentProfile, payload: { instruction: 'Inspect target.' } };

test('request bytes depend on resolved scope, not the rest of the project', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [critic] });
  const [before] = await data.requests('a/check');
  for (let i = 0; i < 30; i++) {
    const views = fixtureViews(); views.agentTools!.read.metadata.inputSchema.description = 'x'.repeat(50_000);
    await data.write(`extra${i}`, { name: `extra${i}`, views });
  }
  const config = await data.config();
  const [after] = await prepareReviewRequests({ ...data, repoId: 'fixture', snapshotHash: 'a'.repeat(64), criticId: 'a/check', preparedConfig: config });
  assert.equal(Buffer.byteLength(JSON.stringify(after)), Buffer.byteLength(JSON.stringify(before)));
  assert.deepEqual(Object.keys(after.configManifest.artifacts), ['a']);
  assert.deepEqual(after.configManifest.declarations.map(value => value.path), ['a/ccdd.json']);
  assert.equal(after.configManifest.configHash, config.configManifest.configHash);
  assert.notEqual(after.configManifest.configHash, before.configManifest.configHash);
  // No global discovery/parse per registry, including 60 concurrent consumers.
  await writeFile(join(data.repoPath, 'extra0/ccdd.json'), '{invalid unrelated config');
  await Promise.all(Array.from({ length: 60 }, async () => {
    const registry = await createReviewTools({ ...after, worktreePath: data.repoPath, audience: 'agent' });
    await registry.close();
  }));
  await data.edit('a', manifest => { manifest.views!.agentTools!.read.metadata.description = 'Changed scoped tool'; });
  await assert.rejects(createReviewTools({ ...after, worktreePath: data.repoPath, audience: 'agent' }), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
});

test('scoped manifests include composition, instruction dependencies and only their runtime and environment entries', async t => {
  const data = await artifactFixture(t);
  for (const id of ['a', 'b', 'c', 'unrelated']) {
    const views = fixtureViews(); views.agentTools!.read.metadata.executionPaths = [`${id}/view.mjs`];
    await data.write(id, { name: id, views, envRequirements: { ready: { description: 'Ready', script: 'ready.mjs' } },
      ...(id === 'a' ? { mounts: { peer: 'b' }, critics: [{ ...critic, payload: { instruction: 'Inspect {c}.' } }] } : {}),
    }, { 'ready.mjs': 'process.exit(0);' });
  }
  await data.write('a/child', { name: 'child' });
  const [request] = await data.requests('a/check');
  assert.deepEqual(Object.keys(request.configManifest.artifacts), ['a', 'child', 'b', 'c']);
  assert.deepEqual(request.configManifest.executionInputs!.map(value => value.path), ['a/view.mjs', 'b/view.mjs', 'c/view.mjs']);
  assert.deepEqual(Object.keys(request.configManifest.envRequirements!), ['a/ready', 'b/ready', 'c/ready']);
  const registry = await createReviewTools({ ...request, worktreePath: data.repoPath, audience: 'agent' }); await registry.close();
  await data.write('a/new-child', { name: 'new-child' });
  await assert.rejects(createReviewTools({ ...request, worktreePath: data.repoPath, audience: 'agent' }), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
});

test('5.0 and 5.1 full-manifest fixture remains executable with identical identity and reuse keys', async t => {
  const data = await artifactFixture(t);
  const fixture = JSON.parse(await readFile(join(process.cwd(), 'test/fixtures/full-manifest-request.json'), 'utf8')) as { files: Record<string, string>; envelope: ReviewEnvelope; inputs: unknown; artifactHashes: unknown };
  for (const [file, text] of Object.entries(fixture.files)) { await mkdir(join(data.repoPath, file, '..'), { recursive: true }); await writeFile(join(data.repoPath, file), text); }
  const config = await data.config();
  assert.equal(config.configManifest.configHash, fixture.envelope.configManifest.configHash);
  const snapshot = await createProjectSnapshot(config, data.repoPath, fixture.envelope.snapshotHash);
  assert.deepEqual(snapshot.inputs, fixture.inputs); assert.deepEqual(snapshot.artifactHashes, fixture.artifactHashes);
  const [current] = await data.requests('a/review');
  assert.deepEqual({ ...current, configManifest: fixture.envelope.configManifest }, fixture.envelope);
  assert.deepEqual(Object.keys(current.configManifest.artifacts), ['a']);
  let executions = 0;
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async request => {
    executions++;
    const registry = await createReviewTools({ ...request, worktreePath: data.repoPath, audience: 'agent' });
    try { assert.equal((await registry.call('read_a')).content[0].type, 'text'); return { verdict: 'GREEN' }; }
    finally { await registry.close(); }
  } } }); data.cleanup(() => broker.close());
  // Reconnect the exact historical envelope through the persisted request seam.
  const submitted = await broker.submitProject({ selection: { kind: 'critic', criticId: 'a/review' } });
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  const saved = JSON.parse(String(db.prepare('SELECT data FROM requests WHERE run_id = ?').get(submitted.id)!.data));
  saved.configManifest = fixture.envelope.configManifest;
  db.prepare('UPDATE requests SET data = ? WHERE id = ?').run(JSON.stringify(saved), saved.id); db.close();
  assert.deepEqual(projectRun(data.stateDir, submitted.id)!.requests[0].configManifest, fixture.envelope.configManifest);
  assert.equal((await broker.run(submitted.id))!.status, 'GREEN');
  assert.equal(executions, 1);
  assert.equal(projectRuns(data.stateDir)[0].requests[0].inputKey, snapshot.inputs['a/review'].key);
  const reused = await broker.submitProject({ selection: { kind: 'critic', criticId: 'a/review' } });
  assert.equal(reused.status, 'GREEN'); assert.equal(reused.requests.length, 0);
  assert.equal(executions, 1, 'historical evidence is reused without another execution');
  await writeFile(join(data.repoPath, 'a/ccdd.json'), fixture.files['a/ccdd.json'].replace('Read a fixture.', 'Changed fixture.'));
  await assert.rejects(createReviewTools({ ...saved, worktreePath: data.repoPath, audience: 'agent' }), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
});

for (const historical of [false, true]) test(`Human claims check only admitted requirements with ${historical ? 'full' : 'scoped'} manifests`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), envRequirements: { ready: { description: 'Ready', script: 'ready.mjs' } }, critics: [{ id: 'human', title: 'Human', profile: { kind: 'human' }, payload: { instruction: 'Inspect a.' } }] }, { 'ready.mjs': 'process.exit(0);' });
  await data.write('b', { name: 'b', basis: true, envRequirements: { fail: { description: 'Not admitted', script: 'fail.mjs' } } }, { 'fail.mjs': 'process.exit(2);' });
  const broker = createBroker({ ...data, detail: 'full', executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('Human review cannot execute automatically.'); }, notifyHuman: async () => {} } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  if (historical) {
    const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
    const request = run.requests[0]; request.configManifest = (await data.config()).configManifest;
    db.prepare('UPDATE requests SET data = ? WHERE id = ?').run(JSON.stringify(request), request.id); db.close();
  }
  const running = broker.run(run.id);
  try {
    for (let i = 0; i < 300 && !broker.getRequest(run.requests[0].id)!.notifiedAt; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(broker.getRequest(run.requests[0].id)!.notifiedAt);
    const claimed = await broker.claimHuman(run.requests[0].id, 'fixture');
    assert.equal(claimed.claimedBy, 'fixture');
    assert.equal(claimed.result, null);
  } finally { broker.cancel(run.id); await running; }
});
