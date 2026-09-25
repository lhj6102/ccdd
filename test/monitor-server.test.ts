import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews } from './helpers/artifacts.js';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { startMonitor } from '../src/monitor/server.js';
import { runUntilSettled } from './helpers/run.js';
import type { MonitorDetail, MonitorOverview, MonitorGraph, MonitorSession } from '../src/monitor/types.js';

async function fixture(t: Parameters<typeof artifactFixture>[0], waiting = false, cycle = false) {
  const data = await artifactFixture(t), marker = join(data.root, 'executed');
  await data.write('a', { name: 'a', views: fixtureViews(), ...(cycle ? { mounts: { peer: 'b' } } : {}), critics: [{ id: 'human', title: 'Human review', profile: { kind: 'human' }, payload: { instruction: cycle ? 'Inspect {a} and {peer}.' : 'Inspect {a}.', authFile: 'DO_NOT_EXPOSE_AUTH' } }] });
  if (cycle) await data.write('b', { name: 'b', basis: true, views: fixtureViews(), mounts: { peer: 'a' } });
  await writeFile(join(data.repoPath, 'ccdd.config.ts'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry({ alarmMethods: [async () => {}] }) }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); if (waiting) await runUntilSettled(broker, run.id);
  const monitor = await startMonitor({ stateDirs: [data.stateDir], port: 0 }); data.cleanup(() => monitor.close());
  const overview = await (await fetch(`${monitor.url}/api/requests`)).json() as MonitorOverview, request = overview.requests[0];
  return { ...data, broker, run, monitor, request, marker, route: `${monitor.url}/api/requests/${request.projectId}/${request.id}` };
}
async function session(url: string, cookie?: string) {
  const response = await fetch(`${url}/api/session`, { headers: cookie ? { cookie } : {} }); const value = await response.json() as MonitorSession;
  return { ...value, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
function post(url: string, browser: Awaited<ReturnType<typeof session>>, value: unknown = {}, extra: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { cookie: browser.cookie, 'x-ccdd-csrf': browser.csrfToken, origin: new URL(url).origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) });
}

test('monitor GET projects folders, qualified Critics, mounts and cycles entirely from saved data', async t => {
  const data = await fixture(t, false, true), before = await readFile(join(data.stateDir, 'broker.sqlite'));
  const detail = await (await fetch(data.route)).json() as MonitorDetail;
  assert.equal(detail.request.criticId, 'a/human'); assert.deepEqual(detail.references, { a: 'a', peer: 'b' }); assert.ok(detail.tools!.some(tool => tool.name === 'read_b'));
  const graph = await (await fetch(`${data.monitor.url}/api/graphs/${data.request.projectId}/${data.run.id}`)).json() as MonitorGraph;
  assert.equal(graph.available, true, graph.unavailableReason ?? ''); assert.ok(graph.graph!.edges.every(edge => edge.cyclic)); assert.ok(graph.graph!.edges.some(edge => edge.relations.some(relation => relation.kind === 'mount')));
  assert.deepEqual(graph.graph!.artifacts.map(a => a.path), ['a', 'b']);
  assert.equal((await fetch(`${data.route}/artifacts/a`)).status, 404);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), before); await assert.rejects(readFile(data.marker), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(detail), /DO_NOT_EXPOSE_AUTH|configManifest|execute\(/);
});

test('current validation is an explicit authenticated POST and neither GET nor POST executes user scripts', async t => {
  const data = await fixture(t), route = `${data.monitor.url}/api/projects/${data.request.projectId}/validation`, browser = await session(data.monitor.url), before = await readFile(join(data.stateDir, 'broker.sqlite'));
  assert.equal((await fetch(route)).status, 404); assert.equal((await post(route, browser, {}, { 'x-ccdd-csrf': '' })).status, 403);
  const response = await post(route, browser); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json() as any).plan.satisfied, false);
  await assert.rejects(readFile(data.marker), { code: 'ENOENT' }); assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), before);
});

test('Human actions require the claimant, same-origin CSRF and schema-valid arguments', async t => {
  const data = await fixture(t, true), first = await session(data.monitor.url), second = await session(data.monitor.url);
  assert.equal((await post(`${data.route}/claim`, first, {}, { 'x-ccdd-csrf': second.csrfToken })).status, 403);
  assert.equal((await post(`${data.route}/claim`, first, {}, { origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await post(`${data.route}/claim`, first, {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(`${data.route}/claim`, first, { reviewerId: second.reviewerId })).status, 400);
  assert.equal((await post(`${data.route}/claim`, first, { extra: 'x'.repeat(33000) })).status, 413);
  assert.equal((await post(`${data.route}/tools/read_a`, first, { arguments: {} })).status, 403);
  const claimed = await post(`${data.route}/claim`, first); assert.equal(claimed.status, 200, await claimed.clone().text());
  assert.equal((await post(`${data.route}/tools/read_a`, second, { arguments: {} })).status, 403);
  assert.equal((await post(`${data.route}/tools/read_a`, first, { arguments: { lineCount: '1' } })).status, 400);
  const result = await post(`${data.route}/tools/read_a`, first, { arguments: { lineCount: 1 } }); assert.equal(result.status, 200); assert.match(JSON.stringify(await result.json()), /Content of a/);
  assert.equal(data.broker.getRequest(data.request.id)!.status, 'WAITING_HUMAN');
  assert.equal((await post(`${data.route}/complete`, first, { verdict: 'GREEN', summary: 'Controlled Human result', evidence: [] })).status, 400);
  const completed = await post(`${data.route}/complete`, first, { verdict: 'GREEN' });
  assert.equal(completed.status, 200, await completed.clone().text()); assert.equal((await completed.json() as MonitorDetail).request.status, 'GREEN');
  assert.equal((await post(`${data.route}/complete`, first, { verdict: 'RED' })).status, 409);
});

test('browser identity survives monitor restart while CSRF requires a fresh session token', async t => {
  const data = await fixture(t, true), before = await session(data.monitor.url); await data.monitor.close();
  const monitor = await startMonitor({ stateDirs: [data.stateDir], port: 0 }); data.cleanup(() => monitor.close());
  const after = await session(monitor.url, before.cookie); assert.equal(after.reviewerId, before.reviewerId); assert.notEqual(after.csrfToken, before.csrfToken);
  const route = `${monitor.url}/api/requests/${data.request.projectId}/${data.request.id}/claim`; assert.equal((await post(route, before)).status, 403); assert.equal((await post(route, after)).status, 200);
});

test('changed Human input is an operational failure and cannot accept a semantic verdict', async t => {
  const data = await fixture(t, true), browser = await session(data.monitor.url); assert.equal((await post(`${data.route}/claim`, browser)).status, 200);
  await writeFile(join(data.repoPath, 'a/content.txt'), 'changed');
  assert.equal((await post(`${data.route}/complete`, browser, { verdict: 'GREEN' })).status, 409);
  assert.equal(data.broker.getRequest(data.request.id)!.result, null);
});



test('unknown routes, duplicate parameters and foreign origins fail with restrictive response headers', async t => {
  const data = await fixture(t);
  assert.equal((await fetch(data.route, { headers: { origin: 'http://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(`${data.monitor.url}/api/requests?limit=1&limit=2`)).status, 400);
  assert.equal((await fetch(`${data.route}/missing`)).status, 404);
  const response = await fetch(data.monitor.url); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy')!, /default-src/);
});
