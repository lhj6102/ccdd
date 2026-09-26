import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createBroker } from '../src/broker/index.js';
import { inspectProject, projectHistory, projectRequests, projectRun, projectRuns, queryProject, planProject } from '../src/project/index.js';
import { normalizeReviewResult } from '../src/review-result.js';
import { main } from '../src/project/cli.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { artifactStream } from './pi-fixture.js';
import { artifactFixture, runtimeCritic, fixtureViews, agentProfile } from './helpers/artifacts.js';

const audit = {
  verdict: 'GREEN' as const, summary: 'Controlled transport fixture, not a Provider evaluation.', evidence: ['Fixture content observed.'],
  provider: 'fixture', model: 'fixture', durationMs: 42, stdout: 'diagnostic output', stderr: '', exitCode: 0,
  toolCalls: Array.from({ length: 12 }, () => ({ name: 'a.read', arguments: { character: 'x'.repeat(4000) }, observation: { artifactId: 'a', operation: 'read', kind: 'content' as const } })),
};
async function fixture(t: Parameters<typeof artifactFixture>[0]) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [{ ...runtimeCritic(), passSchema: { type: 'object', properties: { summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'evidence'] } }] });
  const broker = createBroker({ ...data, executors: { canExecute: () => ({ ok: true }), execute: async () => audit } });
  data.cleanup(() => broker.close());
  const submitted = await broker.submitProject({ selection: { kind: 'all' } });
  const completed = (await broker.run(submitted.id))!;
  return { ...data, broker, completed };
}
async function cli(stateDir: string, args: string[]) {
  let output = '';
  const code = await main([...args, '--state-dir', stateDir], { stdout: { write(text) { output += text; } }, stderr: { write(text) { output += text; } } });
  assert.equal(code, 0, output);
  return output;
}
function compact(value: unknown) {
  const json = JSON.stringify(value);
  for (const field of ['toolCalls', 'arguments', 'observation', 'payload', 'configManifest', 'validationInput', 'completedAt', 'durationMs', 'events', 'telemetry', 'stdout', 'snapshot', 'templates', 'profile']) {
    assert.ok(!json.includes(`"${field}":`), `Unexpected audit field: ${field}`);
  }
}

test('requester defaults reference unchanged stored audit evidence and full API payloads', async t => {
  const data = await fixture(t), { completed, broker, stateDir } = data;
  compact(completed);
  assert.equal(completed.results.length, 1);
  assert.deepEqual(completed.requests[0].result, { requestId: completed.results[0].reference.requestId });
  assert.deepEqual(completed.validation!.critics[0].result, completed.requests[0].result);
  assert.deepEqual(completed.validation!.items[0].result, completed.requests[0].result);
  assert.equal(JSON.stringify(completed).split(audit.evidence[0]).length - 1, 1);
  const result = completed.results[0];
  assert.equal(result.summary, audit.summary); assert.deepEqual(result.evidence, audit.evidence);
  assert.equal(completed.requests[0].target, 'a'); assert.equal(completed.requests[0].criticId, 'a/check');
  const { reference } = result;
  const stored = projectRun(reference.stateDir, reference.runId)!;
  const request = stored.requests.find(r => r.id === reference.requestId)!;
  assert.equal(request.validationInput!.key, completed.requests[0].inputKey);
  assert.deepEqual(request.result, normalizeReviewResult(audit));
  assert.equal(request.result!.toolCalls!.length, 12);
  const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true });
  const bytes = () => db.prepare('SELECT data FROM requests ORDER BY ordinal').all().map(row => row.data);
  const before = bytes();
  compact(broker.getRun(completed.id)); compact(broker.getRequest(request.id)); compact(broker.listRuns());
  compact(projectRuns(stateDir)); compact(projectRequests(stateDir)); compact(projectHistory(stateDir));
  compact(await inspectProject(data));
  const full = createBroker({ ...data, detail: 'full' }); data.cleanup(() => full.close());
  assert.deepEqual(full.getRequest(request.id), request);
  assert.deepEqual(projectRequests(stateDir, completed.id, { detail: 'full' })[0], request);
  assert.deepEqual(projectRuns(stateDir, { detail: 'full' })[0], stored);
  const inspected = await inspectProject({ ...data, detail: 'full' });
  const history = projectHistory(stateDir, { detail: 'full' });
  compact(queryProject(inspected.snapshot, history, { stateDir }));
  const standalonePlan = planProject(inspected.snapshot, history, { stateDir });
  compact(standalonePlan);
  assert.equal(standalonePlan.results.length, 1);
  assert.deepEqual(standalonePlan.critics[0].result, { requestId: request.id });
  assert.deepEqual(standalonePlan.items[0].result, { requestId: request.id });
  assert.equal(JSON.stringify(standalonePlan).split(audit.evidence[0]).length - 1, 1);
  assert.equal(Object.hasOwn(completed.validation!, 'results'), false);
  assert.deepEqual(bytes(), before, 'Request JSON bytes are identical before and after all projections'); db.close();
  const reused = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(reused.status, 'GREEN'); assert.equal(reused.requests.length, 0);
  assert.deepEqual(reused.results[0].reference, reference);
  assert.equal(reused.validation!.critics[0].inputKey, completed.requests[0].inputKey);
  assert.equal((await inspectProject({ ...data, detail: 'full' })).snapshot.inputs['a/check'].key, completed.requests[0].inputKey);

  // Normalize path lengths for a deterministic, reproducible transport-size measurement.
  const measure = (value: unknown) => Buffer.byteLength(JSON.stringify(value).replaceAll(data.root, '/fixture'));
  const fullBytes = measure(request), compactBytes = measure(broker.getRequest(request.id));
  assert.ok(compactBytes < fullBytes * 0.2);
  t.diagnostic(`Fixture request: full=${fullBytes} bytes, compact=${compactBytes} bytes, reduction=${(100 * (1 - compactBytes / fullBytes)).toFixed(2)}%`);
});

test('CLI verification, status, plan, history and requests are compact; full and run show expose audit', async t => {
  const { stateDir, completed } = await fixture(t), requestId = completed.requests[0].id;
  for (const args of [['verify', '--all', '--wait'], ['status'], ['plan', '--all'], ['history'], ['request', 'show', requestId], ['request', 'list'], ['run', 'list']]) {
    compact(JSON.parse(await cli(stateDir, [...args, '--json'])));
  }
  for (const args of [['status'], ['plan', '--all'], ['verify', '--all', '--wait']]) {
    const text = await cli(stateDir, args);
    assert.ok(text.includes(audit.summary)); assert.ok(text.includes(audit.evidence[0])); assert.ok(text.includes(completed.id)); assert.ok(text.includes(stateDir));
  }
  const shown = JSON.parse(await cli(stateDir, ['run', 'show', completed.id, '--json']));
  assert.equal(shown.requests[0].result.toolCalls.length, 12);
  assert.ok(shown.project.snapshot.config.critics[0].payload);
  const full = JSON.parse(await cli(stateDir, ['request', 'show', requestId, '--json', '--full']));
  assert.deepEqual(full.result, shown.requests[0].result);
  const fullStatus = JSON.parse(await cli(stateDir, ['status', '--full', '--json']));
  assert.equal(fullStatus.critics[0].result.result.summary, audit.summary);
  assert.ok(fullStatus.critics[0].input.key);
  assert.ok((await cli(stateDir, ['run', 'show', completed.id])).includes('toolCalls'));
});



for (const missing of [false, true]) test(`compact broker preserves required-observation auditing (missing=${missing})`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  const before = (await inspectProject({ ...data, detail: 'full' })).snapshot.inputs;
  const broker = createBroker({ ...data, executors: createExecutorRegistry({ streamFn: artifactStream({ mode: missing ? 'no-tools' : undefined }) }) });
  data.cleanup(() => broker.close());
  const submitted = await broker.submitProject({ selection: { kind: 'all' } });
  const completed = (await broker.run(submitted.id))!; compact(completed);
  assert.equal(completed.status, missing ? 'ERROR' : 'GREEN');
  const full = projectRun(completed.reference.stateDir, completed.reference.runId)!;
  if (missing) { assert.equal(full.requests[0].result, null); assert.match(full.requests[0].error!, /inspect required artifact/i); }
  else {
    assert.equal(full.requests[0].result!.toolCalls![0].observation!.kind, 'content');
    assert.ok(full.events.some(event => event.type === 'executor.usage'));
    assert.ok(full.events.some(event => event.type === 'artifact.tool.completed'));
  }
  assert.deepEqual((await inspectProject({ ...data, detail: 'full' })).snapshot.inputs, before);
});
