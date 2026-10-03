import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createBroker } from '../src/broker/index.js';
import { projectRequests } from '../src/project/store.js';
import { loadCheck } from '../src/project/load-check.js';
import { openResources, resourcePaths, resourceTestHooks } from '../src/resources.js';
import { artifactFixture, agentProfile, fixtureViews } from './helpers/artifacts.js';

async function isolated(t: test.TestContext) {
  const data = await artifactFixture(t);
  const before = { CCDD_STATE_HOME: process.env.CCDD_STATE_HOME, CCDD_CONFIG_HOME: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(data.root, 'machine');
  process.env.CCDD_CONFIG_HOME = join(data.root, 'config');
  await mkdir(process.env.CCDD_CONFIG_HOME);
  await writeFile(resourcePaths().config, JSON.stringify({ identityCapacity: 100, defaultProviderCapacity: 4 }));
  data.cleanup(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return data;
}

test('compact request profiles retain all execution settings and recover old headers from their own envelope', async t => {
  const data = await isolated(t);
  const profile = { ...agentProfile, reasoning: 'max', timeoutMs: 12345, maxToolCalls: 7, maxTokens: 54321 };
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Original profile', profile, payload: { instruction: 'Controlled profile storage test.' } }] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => ({ verdict: 'GREEN' }) } });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const request = broker.getRun(run.id)!.requests[0];
  assert.deepEqual(request.profile, profile);
  assert.deepEqual(projectRequests(data.stateDir, run.id)[0].profile, profile);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  try {
    const header = JSON.parse(String(db.prepare('SELECT data FROM requests WHERE id=?').get(request.id)!.data));
    header.profile = { kind: 'agent', provider: profile.provider, model: profile.model };
    db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(header), request.id);
  } finally { db.close(); }
  await data.edit('a', manifest => { manifest.critics![0].profile = { ...profile, reasoning: 'low' }; });
  assert.deepEqual(projectRequests(data.stateDir, run.id)[0].profile, profile);
  assert.deepEqual(broker.getRequest(request.id)!.profile, profile);
});

test('blocked resource waiters do not repeatedly acquire write transactions', async t => {
  const data = await isolated(t), store = openResources(); data.cleanup(() => store.close());
  const request = { requestId: 'identity', runId: '', kind: 'identity', repo: 'fixture', identityWeight: 100 };
  const blocker = await store.acquire(request, { signal: new AbortController().signal, waiting() {} });
  const controller = new AbortController();
  let writes = 0;
  resourceTestHooks.admissionWrite = () => { writes++; };
  data.cleanup(() => { delete resourceTestHooks.admissionWrite; });
  const tasks = Array.from({ length: 80 }, () => store.acquire(request, { signal: controller.signal, waiting() {} }));
  const rejected = tasks.map(task => assert.rejects(task, /controlled cancellation/));
  await delay(150);
  assert.equal(writes, 0);
  controller.abort(new Error('controlled cancellation'));
  await Promise.all(rejected); await blocker.release();
});

test('load-check receives a scenario larger than a single OS argument over IPC', async t => {
  const data = await isolated(t);
  const view = { metadata: { description: 'Observe offline data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text' as const], observation: 'content' as const }, script: { command: 'node', args: ['observe.mjs'] } };
  await data.write('a', { name: 'a', views: { agentTools: { observe: view } }, critics: [{ id: 'review', title: 'Offline', profile: agentProfile, payload: { instruction: 'Controlled offline result.' } }] }, {
    'observe.mjs': "for await(const c of process.stdin){};console.log(JSON.stringify({content:[{type:'text',text:'offline'}],observation:{kind:'content'}}));",
  });
  // Unselected result entries are still transported. This isolates the argv bug
  // without forcing every routine test run to launch thousands of processes.
  const criticResults = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`unused-${i}`, { verdict: 'GREEN', detail: 'x'.repeat(256) }]));
  const report = await loadCheck({ outputDir: data.root, project: { repoPath: data.repoPath, selection: { kind: 'all' }, scenario: { steps: [{ operation: 'observe' }], criticResults } } });
  assert.equal(report.status, 'GREEN'); assert.equal(report.completed, 1); assert.equal(report.providerGuard.guardedToolCalls, 1);
});
