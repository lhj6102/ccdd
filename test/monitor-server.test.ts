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
import type { MonitorArtifactPage, MonitorDetail, MonitorOverview, MonitorSession, MonitorGraph, MonitorRunOverview } from '../src/monitor/types.js';
import type { RepoConfig, ReviewRequest, WorkspaceMode } from '../src/contracts.js';

async function fixture(t: TestContext, mode: WorkspaceMode = 'copy', options: { waiting?: boolean; chain?: boolean; command?: boolean; longTool?: boolean } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-monitor-test-')));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await removeOwnedWorkspaceTree(dir); });
  const repoPath = join(dir, 'project'), stateDir = join(dir, 'state'), stateHome = join(dir, 'empty-state-home');
  await mkdir(join(repoPath, 'tests'), { recursive: true });
  await writeFile(join(repoPath, 'why.md'), '# 목적\n두 항목 선택\n');
  await writeFile(join(repoPath, 'tests/example.test.mjs'), `${options.chain ? "await new Promise(resolve => setTimeout(resolve, 350));" : ''}export const count = 2;\n`);
  await writeFile(join(repoPath, 'private.md'), 'UNDECLARED_PRIVATE_CONTENT');
  const config: RepoConfig = {
    artifacts: { why: { type: 'markdown', path: 'why.md' }, tests: { type: 'code', path: 'tests', basis: true } },
    artifactTypes: { markdown: { viewer: 'text', agentTools: { read: {} }, humanTools: { read: { description: '{artifactName}의 줄을 읽습니다.' } } }, code: { viewer: 'files', agentTools: { read: {}, list: {} }, humanTools: { list: { description: '{artifactName}의 파일 목록입니다.' }, read: { description: '{artifactName}의 내부 파일을 읽습니다.' } } } },
    critics: [{ id: 'human-check', title: '<script>unsafe title</script>', target: 'why', deps: ['tests'], profile: { kind: 'human' }, payload: { instruction: '두 항목 기준을 확인하세요.', authFile: 'DO_NOT_EXPOSE_AUTH_METADATA' } }],
  };
  if (options.command) config.artifactTypes.markdown.humanTools = { ...config.artifactTypes.markdown.humanTools, [options.longTool ? 'o'.repeat(64) : 'open']: { description: '고정된 프로그램으로 입력을 확인합니다.', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'command-output.txt'))}, require('node:fs').readFileSync(process.argv[1], 'utf8'))`, '{artifactPath}'] } };
  if (options.longTool) {
    config.artifacts['a'.repeat(64)] = config.artifacts.why; delete config.artifacts.why;
    config.critics[0].target = 'a'.repeat(64);
  }
  if (options.chain) { config.artifacts.implementation = { type: 'code', path: 'tests/example.test.mjs' }; config.critics.push({ id: 'runtime', title: '후속 Runtime', target: 'implementation', deps: ['why', 'tests'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/example.test.mjs'] }, payload: { instruction: '실제 테스트 실행' } }); }
  await writeFile(join(repoPath, 'ccdd.config.json'), JSON.stringify(config));
  const broker = createBroker({ repoPath, stateDir, executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('Monitor must not execute reviews'); }, notifyHuman: async () => { if (!options.waiting) throw new Error('Monitor must not send notifications'); } } });
  cleanup.push(() => broker.close());
  const run = await broker.submit({ mode, requesterId: 'monitor-test' });
  if (options.waiting) { await broker.run(run.id); await mkdir(join(stateDir, 'runs', run.id), { recursive: true }); await writeFile(join(stateDir, 'runs', run.id, 'worker.json'), JSON.stringify({ humanInbox: true, piOptions: {} })); }
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
  assert.equal(read.artifact.description, 'Read text from why using 1-based line ranges.');
  assert.equal(detail.tools?.find(tool => tool.name === 'read_why')?.description, 'why의 줄을 읽습니다.');
  assert.ok('content' in read.result);
  assert.equal(read.result.content, '두 항목 선택\n');
  const listing = await (await fetch(`${data.route}/artifacts/tests`)).json() as MonitorArtifactPage;
  assert.equal(listing.artifact.description, 'List files within tests.');
  assert.ok('entries' in listing.result);
  assert.equal(listing.result.entries[0].path, 'example.test.mjs');
  const source = await (await fetch(`${data.route}/artifacts/tests?operation=read&path=example.test.mjs`)).json() as MonitorArtifactPage;
  assert.equal(source.artifact.description, 'Read text from tests using 1-based line ranges.');
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
  const html = await home.text();
  const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(scripts.length >= 2, html);
  for (const asset of scripts) assert.equal((await fetch(new URL(asset, data.monitor.url))).status, 200);
  const foreignHeaders: Record<string, string>[] = [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
  for (const headers of foreignHeaders) {
    assert.equal((await raw(`${data.monitor.url}/api/requests`, { headers })).status, 403);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal((await raw(data.route, { method })).status, 405);
  assert.equal((await raw(data.route, { method: 'POST', headers: { origin: data.monitor.url } })).status, 405);
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

async function browserSession(url: string) {
  const response = await fetch(`${url}/api/session`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  const data = await response.json() as MonitorSession;
  assert.match(data.reviewerId, /^browser-[a-f0-9]{24}$/);
  return { cookie, ...data };
}
async function post(url: string, session: { cookie: string; csrfToken: string }, value: unknown = {}, extras: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { origin: new URL(url).origin, cookie: session.cookie, 'content-type': 'application/json', 'x-ccdd-csrf': session.csrfToken, ...extras }, body: JSON.stringify(value) });
}

test('Human actions require the browser claimant, valid CSRF and strict bounded JSON', async t => {
  const data = await fixture(t, 'copy', { waiting: true, command: true });
  const first = await browserSession(data.monitor.url), second = await browserSession(data.monitor.url);
  assert.notEqual(first.reviewerId, second.reviewerId);
  const detail = await (await fetch(data.route, { headers: { cookie: first.cookie } })).json() as MonitorDetail;
  assert.equal(detail.human?.canClaim, true);
  assert.ok(detail.tools?.some(tool => tool.name === 'open_why' && tool.operation === 'command'));
  assert.equal((await post(`${data.route}/tools/open_why`, first, { arguments: {} })).status, 403);
  await assert.rejects(access(join(data.dir, 'command-output.txt')));
  assert.equal((await post(`${data.route}/claim`, first, {}, { 'x-ccdd-csrf': second.csrfToken })).status, 403);
  assert.equal((await post(`${data.route}/claim`, first, {}, { origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await post(`${data.route}/claim`, first, {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(`${data.route}/claim`, first, { reviewerId: second.reviewerId })).status, 400);
  assert.equal((await post(`${data.route}/claim`, first, { long: 'x'.repeat(33_000) })).status, 413);
  const claimedResponse = await post(`${data.route}/claim`, first);
  assert.equal(claimedResponse.status, 200, await claimedResponse.clone().text());
  const claimed = await claimedResponse.json() as MonitorDetail;
  assert.equal(claimed.request.claimedBy, first.reviewerId);
  assert.equal(claimed.human?.claimedByMe, true);
  assert.equal(claimed.human?.canComplete, true);
  assert.equal((await post(`${data.route}/claim`, second)).status, 403);
  assert.equal((await post(`${data.route}/tools/read_why`, second, { arguments: {} })).status, 403);
  assert.equal((await post(`${data.route}/complete`, second, { verdict: 'GREEN', summary: '타인 결과', evidence: ['입력을 확인했습니다.'] })).status, 403);
  assert.equal((await post(`${data.route}/complete`, first, { verdict: 'GREEN', summary: '확인', evidence: ['입력을 확인했습니다.'], reviewerId: second.reviewerId })).status, 400);
  assert.equal((await post(`${data.route}/complete`, first, { verdict: 'GREEN', summary: '검토', evidence: [] })).status, 400);
  assert.equal((await post(`${data.route}/complete`, first, { verdict: 'GREEN', summary: '검토', evidence: ['   '] })).status, 400);
  assert.equal((await post(`${data.route}/tools/open_why`, first, { arguments: { command: '/unregistered' } })).status, 400);
  await assert.rejects(access(join(data.dir, 'command-output.txt')));
  const read = await post(`${data.route}/tools/read_why`, first, { arguments: { startLine: 1, lineCount: 1 } });
  assert.equal(read.status, 200, await read.clone().text());
  assert.match(JSON.stringify(await read.json()), /목적/);
  const launch = await post(`${data.route}/tools/open_why`, first, { arguments: {} });
  assert.equal(launch.status, 200, await launch.clone().text());
  assert.equal((await launch.json() as { result: { launched: boolean } }).result.launched, true);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { await access(join(data.dir, 'command-output.txt')); break; } catch { await delay(20); }
  }
  assert.equal(await readFile(join(data.dir, 'command-output.txt'), 'utf8'), '# 목적\n두 항목 선택\n');
  const afterTool = await (await fetch(data.route)).json() as MonitorDetail;
  assert.equal(afterTool.request.status, 'WAITING_HUMAN');
  assert.equal(afterTool.result, null);
  const completed = await post(`${data.route}/complete`, first, { verdict: 'RED', summary: '기준을 충족하지 않습니다.', evidence: ['두 항목 기준을 확인했습니다.'] });
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal((await completed.json() as MonitorDetail).request.status, 'RED');
  assert.equal((await post(`${data.route}/complete`, first, { verdict: 'GREEN', summary: '중복', evidence: ['입력을 확인했습니다.'] })).status, 409);
  assert.equal((await post(`${data.route}/tools/read_why`, first, { arguments: {} })).status, 409);
});

test('browser reviewer identity survives monitor restart and requires the renewed CSRF token', async t => {
  const data = await fixture(t, 'copy', { waiting: true });
  const initial = await browserSession(data.monitor.url);
  assert.equal((await post(`${data.route}/claim`, initial)).status, 200);
  await data.monitor.close();
  const next = await startMonitor({ stateDirs: [data.stateDir], port: 0 });
  t.after(() => next.close());
  const response = await fetch(`${next.url}/api/session`, { headers: { cookie: initial.cookie } });
  const renewed = await response.json() as MonitorSession;
  assert.equal(renewed.reviewerId, initial.reviewerId);
  assert.notEqual(renewed.csrfToken, initial.csrfToken);
  const route = `${next.url}/api/requests/${data.request.projectId}/${data.request.id}`;
  assert.equal((await post(`${route}/complete`, initial, { verdict: 'GREEN', summary: '확인했습니다.', evidence: ['입력을 확인했습니다.'] })).status, 403);
  const result = await post(`${route}/complete`, { cookie: initial.cookie, ...renewed }, { verdict: 'GREEN', summary: '확인했습니다.', evidence: ['입력을 확인했습니다.'] });
  assert.equal(result.status, 200, await result.clone().text());
});

test('Human completion starts a detached successor that finishes after the monitor closes', async t => {
  const data = await fixture(t, 'copy', { waiting: true, chain: true });
  const session = await browserSession(data.monitor.url);
  assert.equal((await post(`${data.route}/claim`, session)).status, 200);
  const result = await post(`${data.route}/complete`, session, { verdict: 'GREEN', summary: '검토 완료', evidence: ['목적 확인'] });
  assert.equal(result.status, 200, await result.clone().text());
  await data.monitor.close();
  const broker = createBroker({ repoPath: data.repoPath, stateDir: data.stateDir });
  try {
    const deadline = Date.now() + 5000;
    let run = broker.getRun(data.run.id);
    while (run && !['GREEN', 'RED', 'ERROR'].includes(run.status) && Date.now() < deadline) { await delay(30); run = broker.getRun(data.run.id); }
    assert.equal(run?.status, 'GREEN', JSON.stringify(run));
    assert.equal(run.requests[1].result?.exitCode, 0);
  } finally { await broker.close(); }
});

test('Human completion rejects changed input and leaves an operational ERROR', async t => {
  const data = await fixture(t, 'copy', { waiting: true });
  const session = await browserSession(data.monitor.url);
  assert.equal((await post(`${data.route}/claim`, session)).status, 200);
  await removeOwnedWorkspaceTree(data.run.workspace.path);
  const response = await post(`${data.route}/complete`, session, { verdict: 'GREEN', summary: '통과', evidence: ['입력을 확인했습니다.'] });
  assert.equal(response.status, 409);
  const detail = await (await fetch(data.route)).json() as MonitorDetail;
  assert.equal(detail.request.status, 'ERROR');
  assert.equal(detail.result, null);
  assert.ok(detail.toolIssue);
});


test('Human tools reject a tampered stored Artifact scope without launching a program', async t => {
  const data = await fixture(t, 'copy', { waiting: true, command: true });
  const session = await browserSession(data.monitor.url);
  assert.equal((await post(`${data.route}/claim`, session)).status, 200);
  editStoredRequest(data.stateDir, data.request.id, request => { request.artifacts[0].path = 'private.md'; });
  const response = await post(`${data.route}/tools/open_why`, session, { arguments: {} });
  assert.equal(response.status, 409);
  await assert.rejects(access(join(data.dir, 'command-output.txt')));
  const detail = await (await fetch(data.route)).json() as MonitorDetail;
  assert.equal(detail.request.status, 'ERROR');
});


test('a maximum-length registered Human tool name remains callable without relaxing request identifiers', async t => {
  const data = await fixture(t, 'copy', { waiting: true, command: true, longTool: true });
  const session = await browserSession(data.monitor.url);
  const toolName = `${'o'.repeat(64)}_${'a'.repeat(64)}`;
  assert.equal(toolName.length, 129);
  const detail = await (await fetch(data.route)).json() as MonitorDetail;
  assert.ok(detail.tools?.some(tool => tool.name === toolName));
  assert.equal((await post(`${data.route}/claim`, session)).status, 200);
  const executed = await post(`${data.route}/tools/${toolName}`, session, { arguments: {} });
  assert.equal(executed.status, 200, await executed.clone().text());
  assert.equal((await executed.json() as { result: { launched: boolean } }).result.launched, true);
  assert.equal(await readFile(join(data.dir, 'command-output.txt'), 'utf8'), '# 목적\n두 항목 선택\n');
  assert.equal((await post(`${data.route}/tools/${toolName}x`, session, { arguments: {} })).status, 400);
  assert.equal((await fetch(`${data.monitor.url}/api/requests/${'p'.repeat(129)}/${data.request.id}`)).status, 400);
});

test('run and graph HTTP views are read-only and share one project/run scope with Kanban', async t => {
  const data = await fixture(t, 'copy', { chain: true });
  const before = await readFile(join(data.stateDir, 'broker.sqlite'));
  await removeOwnedWorkspaceTree(data.repoPath);
  const runsResponse = await fetch(`${data.monitor.url}/api/runs?project=${data.request.projectId}&limit=1`);
  assert.equal(runsResponse.status, 200);
  const runs = await runsResponse.json() as MonitorRunOverview;
  assert.equal(runs.runs.length, 1); assert.equal(runs.runs[0].id, data.run.id);
  assert.equal(runs.runs[0].snapshotHash, data.run.snapshotHash);
  const graphRoute = `${data.monitor.url}/api/graphs/${data.request.projectId}/${data.run.id}`;
  const response = await fetch(graphRoute);
  assert.equal(response.status, 200);
  const graph = await response.json() as MonitorGraph;
  assert.equal(graph.available, true, graph.unavailableReason ?? '');
  assert.equal(graph.run.id, data.run.id); assert.equal(graph.run.snapshotHash, data.run.snapshotHash);
  assert.equal(graph.graph?.critics.length, 2);
  assert.equal(graph.graph?.artifacts.find(artifact => artifact.id === 'tests')?.status, 'BASIS');
  assert.ok(graph.graph?.critics.every(critic => graph.requests.some(request => request.id === critic.requestId)));
  const board = await (await fetch(`${data.monitor.url}/api/requests?project=${data.request.projectId}&run=${data.run.id}`)).json() as MonitorOverview;
  assert.deepEqual(new Set(board.requests.map(request => request.id)), new Set(graph.requests.map(request => request.id)));
  assert.equal((await fetch(`${data.monitor.url}/api/requests?run=${data.run.id}`)).status, 400);
  assert.equal((await fetch(`${data.monitor.url}/api/runs?limit=101`)).status, 400);
  assert.equal((await fetch(`${graphRoute}?snapshot=live`)).status, 400);
  assert.equal((await fetch(`${data.monitor.url}/api/graphs/missing/${data.run.id}`)).status, 404);
  assert.equal((await fetch(`${data.monitor.url}/api/graphs/${data.request.projectId}/missing`)).status, 404);
  assert.equal((await raw(graphRoute, { headers: { origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await raw(graphRoute, { method: 'POST', headers: { origin: data.monitor.url } })).status, 405);
  assert.doesNotMatch(JSON.stringify({ graph, runs }), /DO_NOT_EXPOSE_AUTH|privatePayload|authFile|piOptions|workspace|owner|instruction/);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), before);
});
