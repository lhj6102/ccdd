import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ReviewRequest } from '../src/contracts.js';
import { createMonitorStore } from '../src/monitor/store.js';

const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString();
const present = <T>(value: T | null | undefined): T => { assert.ok(value != null); return value; };
type StoredEvent = { requestId: string | null; runId: string; type: string; at: string };
type Owner = { runId: string; pid: number; identity?: string | null };

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdd-monitor-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, 'home');
  function request(id: string, overrides: Partial<ReviewRequest> = {}): ReviewRequest {
    return {
      id, runId: `run-${id}`, repoId: 'local', snapshotHash: 'snapshot-secret', criticId: `critic-${id}`, title: `Review ${id}`,
      status: 'QUEUED', createdAt: at(0), predecessorId: null, dependsOn: null,
      profile: { kind: 'runtime', command: 'node', args: ['--test', 'test.mjs'] },
      payload: { instruction: 'Read the criterion and review.', privatePayload: 'payload-secret' },
      artifacts: [{ id: 'spec', path: 'spec.md', type: 'markdown' }], artifactTypes: { markdown: { viewer: 'text' } },
      worktreePath: path.join(root, 'workspace'), workspace: {
        version: 1, mode: 'copy', sourcePath: path.join(root, 'repo'), path: path.join(root, 'workspace'),
        hash: 'snapshot-secret', stateDir: path.join(root, 'state'), baselineMetadataHash: 'metadata-secret',
      },
      ...overrides,
    };
  }
  async function state(name: string, requests: ReviewRequest[], options: { repoPath?: string; events?: StoredEvent[]; owners?: Owner[]; directory?: string } = {}) {
    const stateDir = options.directory ?? path.join(stateHome, name);
    const repoPath = options.repoPath ?? path.join(root, 'repos', name);
    await fs.mkdir(stateDir, { recursive: true });
    const db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
    try {
      db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE run_owners (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, process_identity TEXT, token TEXT NOT NULL, claimed_at TEXT NOT NULL);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);`);
      db.prepare('INSERT INTO metadata VALUES (?,?)').run('registered-repo', JSON.stringify({ repoPath, repoId: 'local' }));
      const runs = new Set<string>();
      for (const [ordinal, request] of requests.entries()) {
        if (!runs.has(request.runId)) {
          db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run(request.runId, request.createdAt, request.status, JSON.stringify({ id: request.runId, status: request.status }));
          runs.add(request.runId);
        }
        db.prepare('INSERT INTO requests VALUES (?,?,?,?,?)').run(request.id, request.runId, ordinal, request.status, JSON.stringify(request));
      }
      for (const owner of options.owners ?? []) db.prepare('INSERT INTO run_owners VALUES (?,?,?,?,?)').run(owner.runId, owner.pid, owner.identity ?? null, 'owner-token-secret', at(0));
      for (const event of options.events ?? []) db.prepare('INSERT INTO events (run_id,request_id,created_at,type,message,data) VALUES (?,?,?,?,?,?)').run(event.runId, event.requestId, event.at, event.type, 'event-secret', JSON.stringify({ token: 'event-token-secret' }));
    } finally { db.close(); }
    return { stateDir, repoPath, id: createHash('sha256').update(await fs.realpath(stateDir)).digest('hex') };
  }
  return { root, stateHome, request, state };
}

test('missing default state home is empty and explicit missing stores do not create files', async t => {
  const f = await fixture(t);
  const empty = await createMonitorStore({ stateHome: f.stateHome }).overview();
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.counts, { all: 0, active: 0, attention: 0 });
  assert.equal(empty.hasMore, false);
  await assert.rejects(fs.stat(f.stateHome), { code: 'ENOENT' });
  const missing = path.join(f.root, 'custom', 'missing');
  const store = createMonitorStore({ stateDirs: [missing] });
  const overview = await store.overview();
  assert.equal(overview.projects.length, 1);
  assert.match(present(overview.projects[0].issue), /찾을 수 없습니다/);
  assert.equal(await store.detail(overview.projects[0].id, 'missing'), null);
  assert.equal(await store.request(overview.projects[0].id, 'missing'), null);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
});

test('discovery uses immediate standard stores, explicit-only selection and canonical state identities', async t => {
  const f = await fixture(t);
  const sharedRepo = path.join(f.root, 'shared-repo');
  const a = await f.state('a', [f.request('a')], { repoPath: sharedRepo });
  const b = await f.state('b', [f.request('b')], { repoPath: sharedRepo });
  const custom = await f.state('custom', [f.request('custom')], { directory: path.join(f.root, 'custom-state') });
  await f.state('nested', [f.request('nested')], { directory: path.join(f.stateHome, 'container', 'nested') });
  await fs.symlink(a.stateDir, path.join(f.stateHome, 'alias'));
  const discovered = await createMonitorStore({ stateHome: f.stateHome }).overview();
  assert.equal(discovered.projects.length, 2);
  assert.deepEqual(new Set(discovered.projects.map(project => project.id)), new Set([a.id, b.id]));
  assert.ok(discovered.projects.every(project => project.path === sharedRepo && project.name === 'shared-repo'));
  assert.notEqual(a.id, b.id);
  const explicit = await createMonitorStore({ stateDirs: [custom.stateDir] }).overview();
  assert.deepEqual(explicit.projects.map(project => project.id), [custom.id]);
  const union = await createMonitorStore({ stateHome: f.stateHome, stateDirs: [custom.stateDir, a.stateDir] }).overview();
  assert.equal(union.projects.length, 3);
});

test('project-scoped counts precede filtering and cross-project pages retain a stable attention-first order', async t => {
  const f = await fixture(t);
  const a = await f.state('a', [
    f.request('green', { status: 'GREEN', createdAt: at(30), completedAt: at(40) }),
    f.request('red', { status: 'RED', createdAt: at(10), completedAt: at(20) }),
    f.request('queued', { createdAt: at(15) }),
  ]);
  await f.state('b', [f.request('human', { status: 'WAITING_HUMAN', profile: { kind: 'human' }, createdAt: at(25), startedAt: at(26), notifiedAt: at(27) })]);
  const store = createMonitorStore({ stateHome: f.stateHome });
  const first = await store.overview({ limit: 2 });
  assert.deepEqual(first.counts, { all: 4, active: 2, attention: 2 });
  assert.deepEqual(first.requests.map(request => request.id), ['human', 'queued']);
  assert.equal(first.total, 4);
  assert.equal(first.hasMore, true);
  const second = await store.overview({ limit: 2, offset: 2 });
  assert.deepEqual(second.requests.map(request => request.id), ['red', 'green']);
  assert.equal(second.hasMore, false);
  const attention = await store.overview({ project: a.id, filter: 'attention' });
  assert.deepEqual(attention.counts, { all: 3, active: 1, attention: 1 });
  assert.equal(attention.total, 1);
  assert.equal(attention.projects.length, 2);
  assert.equal(attention.requests[0].id, 'red');
  for (const query of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: 1.5 }]) await assert.rejects(store.overview(query), /조회 조건/);
  assert.deepEqual((await store.overview({ project: 'not-a-project' })).counts, { all: 0, active: 0, attention: 0 });
});

test('a dead owner is a read-only overlay and never reconciles the persisted request or store', async t => {
  const f = await fixture(t);
  const request = f.request('dead', { status: 'RUNNING', startedAt: at(1) });
  const source = await f.state('dead-worker', [request], {
    owners: [{ runId: request.runId, pid: 2_147_483_646, identity: 'ps:old-process' }],
    events: [{ runId: request.runId, requestId: request.id, type: 'request.started', at: at(1) }],
  });
  const database = path.join(source.stateDir, 'broker.sqlite');
  const before = await fs.readFile(database);
  const filesBefore = await fs.readdir(source.stateDir);
  const store = createMonitorStore({ stateDirs: [source.stateDir] });
  const overview = await store.overview();
  assert.equal(overview.requests[0].status, 'RUNNING');
  assert.equal(overview.requests[0].workerState, 'missing');
  assert.match(present(overview.requests[0].waitingReason), /프로세스가 확인되지 않습니다/);
  assert.deepEqual(overview.counts, { all: 1, active: 1, attention: 1 });
  assert.equal(present(await store.detail(source.id, request.id)).request.status, 'RUNNING');
  assert.equal(present(await store.request(source.id, request.id)).request.status, 'RUNNING');
  assert.deepEqual(await fs.readFile(database), before);
  assert.deepEqual(await fs.readdir(source.stateDir), filesBefore);
});

test('Human copy waits are valid without a worker, and claimed/unclaimed waiting messages differ', async t => {
  const f = await fixture(t);
  const waiting = { status: 'WAITING_HUMAN', profile: { kind: 'human' }, startedAt: at(1), notifiedAt: at(2) } as const;
  const unclaimed = f.request('unclaimed', waiting);
  const claimed = f.request('claimed', { ...waiting, claimedBy: '검토자', claimedAt: at(3) });
  const locked = f.request('locked', { ...waiting, workspace: { ...unclaimed.workspace, mode: 'lock' } });
  await f.state('human', [unclaimed, claimed, locked]);
  const result = await createMonitorStore({ stateHome: f.stateHome }).overview();
  const byId = new Map(result.requests.map(request => [request.id, request]));
  assert.equal(present(byId.get('unclaimed')).workerState, 'idle');
  assert.match(present(present(byId.get('unclaimed')).waitingReason), /맡을 사람/);
  assert.equal(present(byId.get('claimed')).workerState, 'idle');
  assert.match(present(present(byId.get('claimed')).waitingReason), /검토자님이 검토 결과를 제출/);
  assert.equal(present(byId.get('locked')).workerState, 'missing');
});

test('pending dependencies and failed ancestors produce different bottlenecks and filter counts', async t => {
  const f = await fixture(t);
  const a = f.request('failure', { runId: 'failed-chain', status: 'RED', title: '요구사항 검토', completedAt: at(2) });
  const b = f.request('blocked', { runId: a.runId, status: 'BLOCKED', predecessorId: a.id });
  const c = f.request('blocked-transitive', { runId: a.runId, status: 'BLOCKED', predecessorId: b.id });
  const q = f.request('pending', { title: '사양 검토' });
  const dependent = f.request('dependency', { runId: q.runId, status: 'BLOCKED', predecessorId: q.id });
  await f.state('chains', [a, b, c, q, dependent], { owners: [{ runId: a.runId, pid: 2_147_483_646, identity: 'stale' }] });
  const store = createMonitorStore({ stateHome: f.stateHome });
  const overview = await store.overview();
  assert.deepEqual(overview.counts, { all: 5, active: 2, attention: 3 });
  const byId = new Map(overview.requests.map(request => [request.id, request]));
  assert.match(present(present(byId.get(c.id)).waitingReason), /요구사항 검토.*기준을 충족하지 못해/);
  assert.equal(present(byId.get(c.id)).workerState, 'idle');
  assert.equal(present(byId.get(c.id)).blockedByFailure, true);
  assert.equal(present(byId.get(dependent.id)).blockedByFailure, false);
  assert.match(present(present(byId.get(dependent.id)).waitingReason), /사양 검토.*통과를 기다리고/);
  assert.deepEqual(new Set((await store.overview({ filter: 'active' })).requests.map(request => request.id)), new Set([q.id, dependent.id]));
});

test('detail retains early lifecycle events beyond 500 records and orders a claim before delayed notification', async t => {
  const f = await fixture(t);
  const request = f.request('timeline', { status: 'GREEN', profile: { kind: 'human' }, createdAt: at(0), startedAt: at(3), claimedAt: at(5), claimedBy: 'reviewer', notifiedAt: at(8), completedAt: at(900) });
  const event = (type: string, seconds: number, requestId: string | null = request.id): StoredEvent => ({ runId: request.runId, requestId, type, at: at(seconds) });
  const source = await f.state('timeline', [request], { events: [
    event('run.submitted', 2, null), event('request.started', 3), event('human.waiting', 4), event('human.claimed', 5), event('human.notified', 8),
    ...Array.from({ length: 600 }, (_, index) => event('artifact.tool.called', 10 + index)), event('request.completed', 900),
  ] });
  const detail = present(await createMonitorStore({ stateHome: f.stateHome }).detail(source.id, request.id));
  assert.deepEqual(detail.timeline, [
    { label: '접수', at: at(2) }, { label: '실행 대기', at: at(2) }, { label: '실행 시작', at: at(3) },
    { label: '사람 대기', at: at(4) }, { label: '담당', at: at(5) }, { label: '알림 전달', at: at(8) }, { label: '완료', at: at(900) },
  ]);
  assert.equal(detail.request.activityAt, at(900));
});

test('a dependent review waits for its own queued event instead of inventing an initial ready time', async t => {
  const f = await fixture(t);
  const first = f.request('first', { status: 'GREEN', completedAt: at(10) });
  const second = f.request('second', { runId: first.runId, predecessorId: first.id, status: 'GREEN', startedAt: at(12), completedAt: at(20) });
  const source = await f.state('dependent-timeline', [first, second], { events: [
    { runId: first.runId, requestId: null, type: 'run.submitted', at: at(1) },
    { runId: first.runId, requestId: first.id, type: 'request.started', at: at(2) },
    { runId: first.runId, requestId: second.id, type: 'request.queued', at: at(11) },
  ] });
  const detail = present(await createMonitorStore({ stateHome: f.stateHome }).detail(source.id, second.id));
  assert.deepEqual(detail.timeline, [{ label: '접수', at: at(1) }, { label: '실행 대기', at: at(11) }, { label: '실행 시작', at: at(12) }, { label: '완료', at: at(20) }]);
});

test('broken database and malformed stored JSON are isolated without leaking raw errors', async t => {
  const f = await fixture(t);
  const valid = await f.state('valid', [f.request('valid')]);
  const corrupt = path.join(f.stateHome, 'corrupt');
  await fs.mkdir(corrupt, { recursive: true });
  await fs.writeFile(path.join(corrupt, 'broker.sqlite'), 'database-secret-not-sqlite');
  const malformed = await f.state('malformed', [f.request('malformed')]);
  const db = new DatabaseSync(path.join(malformed.stateDir, 'broker.sqlite'));
  db.prepare('UPDATE requests SET data=?').run('{malformed-secret');
  db.close();
  const store = createMonitorStore({ stateHome: f.stateHome });
  const overview = await store.overview();
  assert.equal(overview.projects.length, 3);
  assert.equal(overview.projects.filter(project => project.issue).length, 2);
  assert.deepEqual(overview.requests.map(request => request.id), ['valid']);
  assert.ok(!JSON.stringify(overview).includes('secret'));
  assert.ok(await store.detail(valid.id, 'valid'));
  assert.equal(await store.detail(malformed.id, 'malformed'), null);
});

test('public summaries whitelist fields while the internal Artifact lookup retains canonical source identity', async t => {
  const f = await fixture(t);
  const request = f.request('private', {
    status: 'GREEN', completedAt: at(3), profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' },
    result: { verdict: 'GREEN', summary: 'Fits the stated requirement.', evidence: ['spec.md:2'], stdout: 'stdout-secret', stderr: 'stderr-secret', toolCalls: [{ name: 'read_spec', arguments: { secret: 'tool-secret' } }] },
  });
  const source = await f.state('private', [request]);
  const store = createMonitorStore({ stateDirs: [source.stateDir] });
  const overview = await store.overview();
  assert.ok(!JSON.stringify(overview).includes('secret'));
  const detail = present(await store.detail(source.id, request.id));
  assert.deepEqual(detail.profile, request.profile);
  assert.deepEqual(detail.artifacts, request.artifacts);
  assert.deepEqual(detail.result, { summary: 'Fits the stated requirement.', evidence: ['spec.md:2'] });
  assert.equal(detail.instruction, request.payload.instruction);
  assert.ok(!JSON.stringify(detail).includes('secret'));
  const internal = present(await store.request(source.id, request.id));
  assert.deepEqual(internal.request, request);
  assert.equal(internal.repoPath, source.repoPath);
  assert.equal(internal.stateDir, await fs.realpath(source.stateDir));
  assert.equal(internal.repoId, 'local');
  assert.equal(await store.detail('unknown', request.id), null);
  assert.equal(await store.request(source.id, 'unknown'), null);
});

test('pagination works on a substantial completed history without changing stable tie ordering', async t => {
  const f = await fixture(t);
  const requests = Array.from({ length: 2_000 }, (_, index) => f.request(`history-${String(index).padStart(4, '0')}`, { status: 'GREEN', completedAt: at(2) }));
  requests.push(f.request('new-work'));
  await f.state('history', requests);
  const store = createMonitorStore({ stateHome: f.stateHome });
  const page = await store.overview({ limit: 2, offset: 1_999 });
  assert.equal(page.total, 2_001);
  assert.deepEqual(page.counts, { all: 2_001, active: 1, attention: 0 });
  assert.deepEqual(page.requests.map(request => request.id), ['history-1998', 'history-1999']);
  assert.equal(page.hasMore, false);
});

test('kanban lanes have independent counts and pagination with claimed Human requests in progress', async t => {
  const f = await fixture(t);
  const state = await f.state('kanban', [
    f.request('queued'),
    f.request('blocked', { status: 'BLOCKED', predecessorId: 'red', runId: 'run-red' }),
    f.request('unclaimed', { status: 'WAITING_HUMAN', profile: { kind: 'human' }, notifiedAt: at(1) }),
    f.request('claimed', { status: 'WAITING_HUMAN', profile: { kind: 'human' }, claimedBy: 'person', claimedAt: at(2), notifiedAt: at(1) }),
    f.request('running', { status: 'RUNNING' }),
    f.request('red', { status: 'RED', completedAt: at(3) }),
    f.request('error', { status: 'ERROR', completedAt: at(4) }),
    ...Array.from({ length: 55 }, (_, n) => f.request(`green-${n}`, { status: 'GREEN', createdAt: at(n + 10), completedAt: at(n + 11) })),
  ]);
  await f.state('other', [f.request('other-running', { status: 'RUNNING' })]);
  const store = createMonitorStore({ stateHome: f.stateHome });
  const requested = await store.overview({ project: state.id, lane: 'requested', limit: 2 });
  assert.deepEqual(requested.laneCounts, { requested: 3, running: 2, success: 55, failure: 2 });
  assert.equal(requested.total, 3);
  assert.equal(requested.requests.length, 2);
  assert.equal(requested.hasMore, true);
  const remainder = await store.overview({ project: state.id, lane: 'requested', limit: 2, offset: 2 });
  assert.equal(remainder.requests.length, 1);
  assert.equal(remainder.hasMore, false);
  assert.deepEqual(new Set([...requested.requests, ...remainder.requests].map(item => item.id)), new Set(['queued', 'blocked', 'unclaimed']));
  const running = await store.overview({ project: state.id, lane: 'running' });
  assert.deepEqual(new Set(running.requests.map(item => item.id)), new Set(['claimed', 'running']));
  const secondSuccess = await store.overview({ project: state.id, lane: 'success', offset: 50 });
  assert.equal(secondSuccess.requests.length, 5);
  assert.equal(secondSuccess.total, 55);
  await assert.rejects(store.overview({ lane: 'unknown' as 'requested' }));
});
