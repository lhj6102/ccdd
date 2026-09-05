import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { prepareDemo } from '../scripts/prepare-demo.mjs';
import { createExecutorRegistry } from '../src/executors/index.mjs';

const green = { verdict: 'GREEN', summary: 'Integration test reviewer accepted the artifact.', evidence: ['Actual committed fixture read through the HTTP viewer.'] };
const baseRegistry = execute => ({ canExecute: () => ({ ok: true }), execute });

async function setup(t, { executors = baseRegistry(async () => green), human = false, diagnose } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdd-server-test-'));
  const manifest = await prepareDemo({ root: path.join(dir, 'demo') });
  let snapshotCommit = manifest.scenarios[0].commit;
  if (human) {
    const configPath = path.join(manifest.repoPath, 'ccdd.config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config.critics[0].profile = { kind: 'human' };
    await fs.writeFile(configPath, JSON.stringify(config));
    const git = (...args) => execFileSync('git', ['-C', manifest.repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('add', 'ccdd.config.json'); git('commit', '-qm', 'Human review fixture'); snapshotCommit = git('rev-parse', 'HEAD');
  }
  const stateDir = path.join(dir, 'state');
  const server = await startServer({ repoPath: manifest.repoPath, stateDir, manifest, port: 0, executors, ...(diagnose ? { diagnose } : {}) });
  t.after(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body, headers } = {}) => {
    const response = await fetch(`${server.url}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  };
  const submit = reviewRequests => request('/api/runs', { method: 'POST', body: { snapshotCommit, requesterId: 'http-test', ...(reviewRequests === undefined ? {} : { reviewRequests }) } });
  return { ...server, request, submit, snapshotCommit, manifest, stateDir };
}

async function waitFor(read, check) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) { const value = await read(); if (check(value)) return value; await delay(10); }
  throw new Error('Timed out waiting for HTTP review state.');
}

test('HTTP exposes asynchronous handles, pinned artifact views, dependency state and persisted results', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const context = await setup(t, { executors: baseRegistry(async (request, { signal }) => {
    calls.push(request.criticId);
    if (calls.length === 1) await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true }))]);
    return green;
  }) });
  t.after(() => release());
  const health = await context.request('/api/health');
  assert.equal(health.status, 200); assert.equal(health.data.ok, true);
  assert.equal(health.data.readinessChecked, false);
  assert.equal(health.data.providerReady, null);
  const demo = await context.request('/api/demo');
  assert.equal(demo.data.scenarios.length, 4);
  assert.equal(demo.data.graph.length, 4);
  assert.equal(demo.data.scenarios[0].reviewRequests.length, 3);
  const altered = structuredClone(demo.data.scenarios[0].reviewRequests);
  altered[0].payload.instruction = 'Replace committed criterion.';
  assert.equal((await context.submit(altered)).status, 400);
  const submitted = await context.submit(demo.data.scenarios[0].reviewRequests);
  assert.equal(submitted.status, 202);
  const runId = submitted.data.id;
  assert.equal(submitted.data.snapshotCommit, context.snapshotCommit);
  assert.deepEqual(submitted.data.scope, { kind: 'chain' });
  const firstId = submitted.data.requests[0].id;
  const secondId = submitted.data.requests[1].id;
  assert.equal((await context.request(`/api/requests/${secondId}/artifacts/tests`)).status, 409);
  await waitFor(() => context.request(`/api/requests/${firstId}`), result => Boolean(result.data.worktreePath));
  const artifact = await context.request(`/api/requests/${firstId}/artifacts/why`);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.data.snapshotCommit, context.snapshotCommit);
  assert.match(artifact.data.content, /최대 3개/);
  assert.equal(artifact.data.path, 'why.md');
  assert.equal((await context.request(`/api/requests/${firstId}/artifacts/implementation`)).status, 400);
  assert.equal((await context.request(`/api/requests/${firstId}/artifacts/why?file=../spec.md`)).status, 400);
  assert.deepEqual(calls, ['spec-why']);
  release();
  const finished = await waitFor(() => context.request(`/api/runs/${runId}`), result => result.data.status === 'GREEN');
  assert.deepEqual(finished.data.requests.map(request => request.status), ['GREEN', 'GREEN', 'GREEN']);
  const listing = await context.request(`/api/requests/${secondId}/artifacts/tests`);
  assert.equal(listing.status, 200);
  assert.ok(listing.data.files.some(file => file.name === 'rank.test.mjs'));
  const testFile = await context.request(`/api/requests/${secondId}/artifacts/tests?file=rank.test.mjs`);
  assert.match(testFile.data.content, /node:test/);
  assert.equal((await context.request(`/api/requests/${secondId}/artifacts/tests?file=../../why.md`)).status, 400);
  assert.equal((await context.request('/api/runs')).data[0].id, runId);
  assert.equal((await context.request('/api/runs/missing')).status, 404);
});

test('HTTP selects only the middle Critic, rejects mismatched selectors and persists a scoped single GREEN', async t => {
  const received = [];
  const checks = [];
  const executors = {
    canExecute: request => { checks.push(request.criticId); return { ok: request.criticId === 'tests-spec', reason: 'Only this Critic is available.' }; },
    execute: async request => { received.push(request.criticId); return green; },
  };
  const context = await setup(t, { executors });
  const demo = await context.request('/api/demo');
  const chain = demo.data.scenarios[0].reviewRequests;
  const submit = body => context.request('/api/runs', { method: 'POST', body: { snapshotCommit: context.snapshotCommit, requesterId: 'feature-builder', ...body } });
  for (const body of [
    { criticId: 'missing' },
    { criticId: '' },
    { criticId: null },
    { criticId: 'tests-spec', reviewRequests: [] },
    { criticId: 'tests-spec', reviewRequests: [chain[0]] },
    { criticId: 'tests-spec', reviewRequests: chain },
  ]) assert.equal((await submit(body)).status, 400);
  assert.deepEqual(checks, []);
  assert.deepEqual((await context.request('/api/runs')).data, []);
  const submitted = await submit({ criticId: 'tests-spec', reviewRequests: [chain[1]] });
  assert.equal(submitted.status, 202);
  assert.deepEqual(submitted.data.scope, { kind: 'critic', criticId: 'tests-spec' });
  assert.equal(submitted.data.requests.length, 1);
  assert.equal(submitted.data.requests[0].criticId, 'tests-spec');
  assert.equal(submitted.data.requests[0].predecessorId, null);
  assert.equal(submitted.data.requests[0].dependsOn, 'spec-why');
  const finished = await waitFor(() => context.request(`/api/runs/${submitted.data.id}`), result => result.data.status === 'GREEN');
  assert.deepEqual(received, ['tests-spec']);
  assert.deepEqual(checks, ['tests-spec']);
  assert.equal(finished.data.requests.length, 1, 'Single GREEN certifies only the selected Critic');
  assert.deepEqual(finished.data.scope, submitted.data.scope);
  assert.deepEqual((await context.request('/api/runs')).data[0].scope, submitted.data.scope);
  await context.close();
  const reopened = await startServer({ repoPath: context.manifest.repoPath, stateDir: context.stateDir, manifest: context.manifest, port: 0, executors });
  try {
    const persisted = await (await fetch(`${reopened.url}/api/runs/${submitted.data.id}`)).json();
    assert.equal(persisted.status, 'GREEN');
    assert.deepEqual(persisted.scope, { kind: 'critic', criticId: 'tests-spec' });
    assert.deepEqual(persisted.requests.map(request => request.criticId), ['tests-spec']);
    assert.deepEqual(received, ['tests-spec']);
  } finally { await reopened.close(); }
});

test('HTTP runtime-only review succeeds even when Codex is unavailable', async t => {
  const context = await setup(t, { executors: createExecutorRegistry({ codexPath: '/missing-ccdd-codex' }) });
  assert.equal((await context.submit()).status, 400, 'A full chain still requires its Agent Provider');
  const submitted = await context.request('/api/runs', { method: 'POST', body: { snapshotCommit: context.snapshotCommit, requesterId: 'runtime-builder', criticId: 'implementation-tests' } });
  assert.equal(submitted.status, 202);
  const finished = await waitFor(() => context.request(`/api/runs/${submitted.data.id}`), result => ['GREEN', 'RED', 'ERROR'].includes(result.data.status));
  assert.equal(finished.data.status, 'GREEN', JSON.stringify(finished.data));
  assert.deepEqual(finished.data.scope, { kind: 'critic', criticId: 'implementation-tests' });
  assert.equal(finished.data.requests.length, 1);
  assert.equal(finished.data.requests[0].predecessorId, null);
  assert.equal(finished.data.requests[0].result.exitCode, 0);
  assert.match(finished.data.requests[0].result.stdout, /tests 6/);
});

test('HTTP doctor forwards the selected snapshot and Critic, returns NOT_READY as a report and never creates review history', async t => {
  const diagnoses = [];
  let reviews = 0;
  const executors = baseRegistry(async () => { reviews += 1; return green; });
  const context = await setup(t, { executors, diagnose: async options => {
    diagnoses.push(options);
    return { status: 'NOT_READY', snapshotCommit: options.snapshotCommit, scope: { kind: 'critic', criticId: options.criticId }, checks: [{ name: 'provider', status: 'FAIL', message: 'Test diagnosis: authentication unavailable.' }] };
  } });
  const health = await context.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.readinessChecked, false);
  assert.equal(health.data.providerReady, null, 'Liveness must not imply Provider readiness');
  assert.equal(diagnoses.length, 0, 'Health does not silently invoke a Provider');
  assert.equal((await context.request('/api/doctor', { method: 'POST', body: {} })).status, 400);
  assert.equal(diagnoses.length, 0);
  const selectedCommit = context.manifest.scenarios[1].commit;
  const report = await context.request('/api/doctor', { method: 'POST', body: { snapshotCommit: selectedCommit, criticId: 'tests-spec' } });
  assert.equal(report.status, 200, 'NOT_READY is a successful diagnostic response, not a transport failure');
  assert.equal(report.data.status, 'NOT_READY');
  assert.equal(report.data.snapshotCommit, selectedCommit);
  assert.deepEqual(report.data.scope, { kind: 'critic', criticId: 'tests-spec' });
  assert.equal(diagnoses.length, 1);
  assert.equal(diagnoses[0].repoPath, context.manifest.repoPath);
  assert.equal(diagnoses[0].repoId, context.manifest.repoId);
  assert.equal(diagnoses[0].snapshotCommit, selectedCommit);
  assert.equal(diagnoses[0].criticId, 'tests-spec');
  assert.equal(diagnoses[0].executors, executors);
  assert.ok(diagnoses[0].signal instanceof AbortSignal);
  assert.equal(diagnoses[0].signal.aborted, false);
  assert.equal(reviews, 0);
  assert.deepEqual((await context.request('/api/runs')).data, []);
  const after = await context.request('/api/health');
  assert.equal(after.data.readinessChecked, false);
  assert.equal(after.data.providerReady, null, 'A separate diagnostic must not turn liveness into an implicit readiness cache');
});

test('loopback HTTP rejects foreign Host/Origin, malformed and oversized writes', async t => {
  const context = await setup(t);
  // Node fetch replaces Host; a raw HTTP request exercises the actual header boundary.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${context.url}/api/health`, { headers: { host: 'attacker.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await context.request('/api/health', { headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await context.request('/api/runs', { method: 'POST', body: { snapshotCommit: context.snapshotCommit }, headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await context.request('/api/health', { headers: { origin: context.url } })).status, 200);
  assert.equal((await context.request('/api/runs', { method: 'POST', body: '{}' , headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await context.request('/api/runs', { method: 'POST', body: '{not JSON' })).status, 400);
  assert.equal((await context.request('/api/runs', { method: 'POST', body: { snapshotCommit: 'HEAD' } })).status, 400);
  assert.equal((await context.request('/api/runs', { method: 'POST', body: { snapshotCommit: context.snapshotCommit, padding: 'x'.repeat(66_000) } })).status, 413);
  assert.deepEqual((await context.request('/api/runs')).data, []);
});

test('human review over HTTP needs claim ownership before completing and releasing downstream reviews', async t => {
  const notifications = [];
  const calls = [];
  const context = await setup(t, { human: true, executors: {
    ...baseRegistry(async request => { calls.push(request.criticId); return green; }),
    notifyHuman: async request => { notifications.push(request.id); },
  } });
  const submitted = await context.submit();
  assert.equal(submitted.status, 202);
  const id = submitted.data.requests[0].id;
  await waitFor(() => context.request(`/api/requests/${id}`), result => result.data.status === 'WAITING_HUMAN');
  assert.deepEqual(notifications, [id]); assert.deepEqual(calls, []);
  assert.equal((await context.request(`/api/requests/${id}/result`, { method: 'POST', body: { reviewerId: 'reviewer-a', result: green } })).status, 400);
  const claimed = await context.request(`/api/requests/${id}/claim`, { method: 'POST', body: { reviewerId: 'reviewer-a' } });
  assert.equal(claimed.status, 200); assert.equal(claimed.data.claimedBy, 'reviewer-a');
  assert.equal((await context.request(`/api/requests/${id}/claim`, { method: 'POST', body: { reviewerId: 'reviewer-b' } })).status, 400);
  assert.equal((await context.request(`/api/requests/${id}/result`, { method: 'POST', body: { reviewerId: 'reviewer-b', result: green } })).status, 400);
  const completed = await context.request(`/api/requests/${id}/result`, { method: 'POST', body: { reviewerId: 'reviewer-a', result: green } });
  assert.equal(completed.status, 200); assert.equal(completed.data.status, 'GREEN');
  await waitFor(() => context.request(`/api/runs/${submitted.data.id}`), result => result.data.status === 'GREEN');
  assert.deepEqual(calls, ['tests-spec', 'implementation-tests']);
});
