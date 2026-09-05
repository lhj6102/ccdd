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

const green = { verdict: 'GREEN', summary: 'Integration test reviewer accepted the artifact.', evidence: ['Actual committed fixture read through the HTTP viewer.'] };
const baseRegistry = execute => ({ canExecute: () => ({ ok: true }), execute });

async function setup(t, { executors = baseRegistry(async () => green), human = false } = {}) {
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
  const server = await startServer({ repoPath: manifest.repoPath, stateDir: path.join(dir, 'state'), manifest, port: 0, executors });
  t.after(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body, headers } = {}) => {
    const response = await fetch(`${server.url}${route}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  };
  const submit = reviewRequests => request('/api/runs', { method: 'POST', body: { snapshotCommit, requesterId: 'http-test', ...(reviewRequests === undefined ? {} : { reviewRequests }) } });
  return { ...server, request, submit, snapshotCommit, manifest };
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
