import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, open, realpath, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBroker } from '../src/broker/index.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import { startMonitor } from '../src/monitor/server.js';
import type { MonitorArtifactPage, MonitorDetail, MonitorOverview } from '../src/monitor/types.js';
import type { RepoConfig, ReviewRequest, WorkspaceMode } from '../src/contracts.js';

async function fixture(t: TestContext, mode: WorkspaceMode = 'copy') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-monitor-test-')));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await removeOwnedWorkspaceTree(dir); });
  const repoPath = join(dir, 'project'), stateDir = join(dir, 'state'), stateHome = join(dir, 'empty-state-home');
  await mkdir(join(repoPath, 'tests'), { recursive: true });
  await writeFile(join(repoPath, 'why.md'), '# 목적\n두 항목 선택\n');
  await writeFile(join(repoPath, 'tests/example.test.mjs'), 'export const count = 2;\n');
  await writeFile(join(repoPath, 'private.md'), 'UNDECLARED_PRIVATE_CONTENT');
  const config: RepoConfig = {
    artifacts: { why: { type: 'markdown', path: 'why.md' }, tests: { type: 'code', path: 'tests' } },
    artifactTypes: { markdown: { viewer: 'text', tools: { read: { description: '{artifactName}의 줄을 읽습니다.' } } }, code: { viewer: 'files', tools: { list: { description: '{artifactName}의 파일 목록입니다.' }, read: { description: '{artifactName}의 내부 파일을 읽습니다.' } } } },
    critics: [{ id: 'human-check', title: '<script>unsafe title</script>', dependsOn: null, artifacts: ['why', 'tests'], profile: { kind: 'human' }, payload: { instruction: '두 항목 기준을 확인하세요.', authFile: 'DO_NOT_EXPOSE_AUTH_METADATA' } }],
  };
  await writeFile(join(repoPath, 'ccdd.config.json'), JSON.stringify(config));
  const broker = createBroker({ repoPath, stateDir, executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('Monitor must not execute reviews'); }, notifyHuman: async () => { throw new Error('Monitor must not send notifications'); } } });
  cleanup.push(() => broker.close());
  const run = await broker.submit({ mode, requesterId: 'monitor-test' });
  await broker.close();
  await writeFile(join(stateDir, 'worker.json'), JSON.stringify({ piOptions: { authFile: 'DO_NOT_EXPOSE_AUTH_METADATA' }, secret: 'DO_NOT_EXPOSE_AUTH_SECRET' }));
  const monitor = await startMonitor({ stateDirs: [stateDir], stateHome, port: 0 });
  cleanup.push(() => monitor.close());
  const overview = await (await fetch(`${monitor.url}/api/requests`)).json() as MonitorOverview;
  const request = overview.requests.find(item => item.id === run.requests[0].id);
  assert.ok(request, JSON.stringify(overview));
  const route = `${monitor.url}/api/requests/${request.projectId}/${request.id}`;
  return { dir, repoPath, stateDir, stateHome, monitor, run, request, route };
}

function editStoredRequest(stateDir: string, requestId: string, edit: (request: ReviewRequest) => void): void {
  const db = new DatabaseSync(join(stateDir, 'broker.sqlite'));
  try {
    const row = db.prepare('SELECT data FROM requests WHERE id=?').get(requestId);
    assert.ok(row);
    assert.equal(typeof row.data, 'string');
    const record = JSON.parse(row.data as string) as ReviewRequest;
    edit(record);
    db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(record), requestId);
  } finally { db.close(); }
}

async function raw(url: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  return new Promise((ok, no) => {
    const request = httpRequest(url, options, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => ok({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', no); request.end();
  });
}

test('monitor serves existing database state and scoped artifacts without executing or writing review observations', async t => {
  const data = await fixture(t);
  const before = await readFile(join(data.stateDir, 'broker.sqlite'));
  const overview = await (await fetch(`${data.monitor.url}/api/requests?filter=all&limit=1&offset=0`)).json() as MonitorOverview;
  assert.equal(overview.requests.length, 1);
  assert.equal(overview.requests[0].status, 'QUEUED');
  const detail = await (await fetch(data.route)).json() as MonitorDetail;
  assert.equal(detail.instruction, '두 항목 기준을 확인하세요.');
  assert.equal(detail.result, null);
  assert.doesNotMatch(JSON.stringify({ overview, detail }), /DO_NOT_EXPOSE_AUTH|piOptions|authFile|snapshotHash|workspace/);
  const read = await (await fetch(`${data.route}/artifacts/why?startLine=2&lineCount=1`)).json() as MonitorArtifactPage;
  assert.equal(read.artifact.description, 'why의 줄을 읽습니다.');
  assert.ok('content' in read.result);
  assert.equal(read.result.content, '두 항목 선택\n');
  const listing = await (await fetch(`${data.route}/artifacts/tests`)).json() as MonitorArtifactPage;
  assert.equal(listing.artifact.description, 'tests의 파일 목록입니다.');
  assert.ok('entries' in listing.result);
  assert.equal(listing.result.entries[0].path, 'example.test.mjs');
  const source = await (await fetch(`${data.route}/artifacts/tests?operation=read&path=example.test.mjs`)).json() as MonitorArtifactPage;
  assert.equal(source.artifact.description, 'tests의 내부 파일을 읽습니다.');
  assert.ok('content' in source.result);
  assert.match(source.result.content, /count = 2/);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), before);
  assert.equal((await readdir(data.stateDir)).some(name => /owner|inbox/.test(name)), false);
});

test('monitor blocks foreign browser access and all mutations; static resources use restrictive headers', async t => {
  const data = await fixture(t);
  const home = await fetch(data.monitor.url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(home.headers.get('access-control-allow-origin'), null);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await home.text(), /\/client\.js/);
  assert.equal((await fetch(`${data.monitor.url}/style.css`)).status, 200);
  assert.equal((await fetch(`${data.monitor.url}/client.js`)).status, 200);
  const foreignHeaders: Record<string, string>[] = [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
  for (const headers of foreignHeaders) {
    assert.equal((await raw(`${data.monitor.url}/api/requests`, { headers })).status, 403);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal((await raw(data.route, { method })).status, 405);
  assert.equal((await raw(data.route, { headers: { origin: data.monitor.url, 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('monitor rejects unknown IDs, extra arguments, coercion, traversal and out-of-scope reads', async t => {
  const data = await fixture(t);
  for (const suffix of [
    '/artifacts/why?path=', '/artifacts/why?operation=list', '/artifacts/why?offset=0', '/artifacts/why?lineCount=501',
    '/artifacts/why?lineCount=null', '/artifacts/why?startLine=1e2', '/artifacts/why?startLine=1&startLine=2',
    '/artifacts/why?unexpected=1', '/artifacts/tests?operation=read', '/artifacts/tests?operation=read&path=../private.md',
    '/artifacts/tests?operation=read&path=%2Fetc%2Fpasswd', '/artifacts/tests?startLine=1', '/artifacts/why?operation=execute',
  ]) assert.equal((await fetch(data.route + suffix)).status, 400, suffix);
  assert.equal((await fetch(`${data.route}/artifacts/private`)).status, 404);
  assert.equal((await fetch(`${data.monitor.url}/api/requests/missing/missing`)).status, 404);
  assert.equal((await fetch(`${data.monitor.url}/api/requests?filter=invalid`)).status, 400);
  assert.equal((await fetch(`${data.monitor.url}/api/requests?limit=101`)).status, 400);
  assert.equal((await fetch(`${data.monitor.url}/api/requests?project=../private`)).status, 400);
  assert.equal((await fetch(`${data.monitor.url}/api/requests?limit=1&limit=2`)).status, 400);
});

test('monitor rejects tampered stored artifact scope and workspace identity', async t => {
  const data = await fixture(t);
  editStoredRequest(data.stateDir, data.request.id, request => { request.artifacts[0].path = 'private.md'; });
  const scope = await fetch(`${data.route}/artifacts/why`);
  assert.equal(scope.status, 409);
  assert.doesNotMatch(await scope.text(), /UNDECLARED_PRIVATE_CONTENT/);
  editStoredRequest(data.stateDir, data.request.id, request => { request.workspace.sourcePath = data.dir; });
  const identity = await fetch(`${data.route}/artifacts/why`);
  assert.equal(identity.status, 409);
  assert.doesNotMatch(await identity.text(), /UNDECLARED_PRIVATE_CONTENT|DO_NOT_EXPOSE_AUTH/);
});

test('copied artifact remains readable after source removal, while modified lock input fails integrity', async t => {
  const copied = await fixture(t);
  await removeOwnedWorkspaceTree(copied.repoPath);
  assert.equal((await fetch(`${copied.route}/artifacts/why`)).status, 200);
  const locked = await fixture(t, 'lock');
  await writeFile(join(locked.repoPath, 'why.md'), 'Changed after capture');
  const response = await fetch(`${locked.route}/artifacts/why`);
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /입력이 변경/);
});

test('missing copied input is reported without leaking internal paths', async t => {
  const data = await fixture(t);
  await removeOwnedWorkspaceTree(data.run.workspace.path);
  const response = await fetch(`${data.route}/artifacts/why`);
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.match(body, /찾을 수 없습니다/);
  assert.equal(body.includes(data.stateDir), false);
});

test('artifact concurrency is bounded and client disconnect stops in-flight hash verification', async t => {
  const data = await fixture(t, 'lock');
  const file = await open(join(data.repoPath, 'large.bin'), 'w');
  try { await file.truncate(2 * 1024 ** 3); } finally { await file.close(); }
  const first = new AbortController(), second = new AbortController();
  const pending = [first, second].map(controller => fetch(`${data.route}/artifacts/why`, { signal: controller.signal }).catch(() => undefined));
  await delay(40);
  const crowded = await fetch(`${data.route}/artifacts/why`);
  assert.equal(crowded.status, 429);
  const started = performance.now();
  first.abort(); second.abort();
  await Promise.all(pending);
  await data.monitor.close();
  assert.ok(performance.now() - started < 1000, 'Disconnected Artifact hash verification did not stop promptly');
});

test('monitor CLI starts without a repository or authentication and stops cleanly', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-monitor-cli-')));
  t.after(() => removeOwnedWorkspaceTree(dir));
  const stateHome = join(dir, 'no-state');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'monitor', '--port', '0'], { cwd: dir, env: { ...process.env, CCDD_STATE_HOME: stateHome, CCDD_PI_AUTH_FILE: '/unavailable/auth.json' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { output += text; }); child.stderr.on('data', text => { errors += text; });
  const deadline = Date.now() + 5000;
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output) && child.exitCode === null && Date.now() < deadline) await delay(20);
  const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
  assert.ok(url, errors || output);
  const overview = await (await fetch(`${url}/api/requests`)).json() as MonitorOverview;
  assert.equal(overview.requests.length, 0);
  const stopped = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await stopped, 0, errors);
  await assert.rejects(access(stateHome));
});

test('monitor CLI rejects unrelated or conflicting flags before starting', async () => {
  const { main } = await import('../src/cli.js');
  for (const args of [['monitor', '--copy'], ['monitor', '--pi-auth-file', '/tmp/auth'], ['monitor', '--repo', '/tmp', '--state-dir', '/tmp/state'], ['monitor', '--port', '65536'], ['monitor', '--wait'], ['monitor', 'unexpected']]) {
    let output = '';
    const sink = { write: (text: string) => { output += text; } };
    assert.equal(await main(args, { stdout: sink, stderr: sink }), 2, args.join(' '));
    assert.ok(output.length > 0);
  }
});
