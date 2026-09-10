import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ReviewRequest } from '../src/contracts.js';
import type { GraphDefinition } from '../src/broker/graph.js';
type StoredRequest = Omit<ReviewRequest, 'target' | 'deps'> & Partial<Pick<ReviewRequest, 'target' | 'deps'>> & { dependsOn?: string | null };
import { createMonitorStore } from '../src/monitor/store.js';

const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 6, 0, 0, seconds)).toISOString();
const present = <T>(value: T | null | undefined): T => { assert.ok(value != null); return value; };
type StoredEvent = { requestId: string | null; runId: string; type: string; at: string };
type Owner = { runId: string; pid: number; identity?: string | null };

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdd-monitor-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateHome = path.join(root, 'home');
  function request(id: string, overrides: Partial<StoredRequest> = {}): StoredRequest {
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
  async function state(name: string, requests: StoredRequest[], options: { repoPath?: string; events?: StoredEvent[]; owners?: Owner[]; directory?: string; runData?: Record<string, Record<string, unknown>> } = {}) {
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
          db.prepare('INSERT INTO runs VALUES (?,?,?,?)').run(request.runId, request.createdAt, request.status, JSON.stringify({ id: request.runId, status: request.status, ...options.runData?.[request.runId] }));
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
  assert.match(present(overview.projects[0].issue), /could not be found/);
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
  for (const query of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: 1.5 }]) await assert.rejects(store.overview(query), /listing query/);
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
  assert.match(present(overview.requests[0].waitingReason), /worker process could not be found/);
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
  const claimed = f.request('claimed', { ...waiting, claimedBy: 'Reviewer', claimedAt: at(3) });
  const locked = f.request('locked', { ...waiting, workspace: { ...unclaimed.workspace, mode: 'lock' } });
  await f.state('human', [unclaimed, claimed, locked]);
  const result = await createMonitorStore({ stateHome: f.stateHome }).overview();
  const byId = new Map(result.requests.map(request => [request.id, request]));
  assert.equal(present(byId.get('unclaimed')).workerState, 'idle');
  assert.match(present(present(byId.get('unclaimed')).waitingReason), /reviewer to claim/);
  assert.equal(present(byId.get('claimed')).workerState, 'idle');
  assert.match(present(present(byId.get('claimed')).waitingReason), /Reviewer to submit a review result/);
  assert.equal(present(byId.get('locked')).workerState, 'missing');
});

test('pending dependencies and failed ancestors produce different bottlenecks and filter counts', async t => {
  const f = await fixture(t);
  const a = f.request('failure', { runId: 'failed-chain', status: 'RED', title: 'Requirements review', completedAt: at(2) });
  const b = f.request('blocked', { runId: a.runId, status: 'BLOCKED', predecessorId: a.id });
  const c = f.request('blocked-transitive', { runId: a.runId, status: 'BLOCKED', predecessorId: b.id });
  const q = f.request('pending', { title: 'Specification review' });
  const dependent = f.request('dependency', { runId: q.runId, status: 'BLOCKED', predecessorId: q.id });
  await f.state('chains', [a, b, c, q, dependent], { owners: [{ runId: a.runId, pid: 2_147_483_646, identity: 'stale' }] });
  const store = createMonitorStore({ stateHome: f.stateHome });
  const overview = await store.overview();
  assert.deepEqual(overview.counts, { all: 5, active: 2, attention: 3 });
  const byId = new Map(overview.requests.map(request => [request.id, request]));
  assert.match(present(present(byId.get(c.id)).waitingReason), /Requirements review.*did not meet the criteria/);
  assert.equal(present(byId.get(c.id)).workerState, 'idle');
  assert.equal(present(byId.get(c.id)).blockedByFailure, true);
  assert.equal(present(byId.get(dependent.id)).blockedByFailure, false);
  assert.match(present(present(byId.get(dependent.id)).waitingReason), /Specification review.*to pass/);
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
    { label: 'Submitted', at: at(2) }, { label: 'Queued', at: at(2) }, { label: 'Started', at: at(3) },
    { label: 'Awaiting Human', at: at(4) }, { label: 'Claimed', at: at(5) }, { label: 'Notification delivered', at: at(8) }, { label: 'Completed', at: at(900) },
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
  assert.deepEqual(detail.timeline, [{ label: 'Submitted', at: at(1) }, { label: 'Queued', at: at(11) }, { label: 'Started', at: at(12) }, { label: 'Completed', at: at(20) }]);
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

test('group observation projects saved composition without new dependency edges or source access', async t => {
  const f = await fixture(t), hash = 'a'.repeat(64);
  const graph: GraphDefinition = { version: 1, artifacts: {
    effect: { type: 'vfx', path: 'effect.vfx' }, preview: { type: 'image', path: 'preview.png' }, published: { type: 'text', path: 'published.md' },
    bundle: { kind: 'group', members: ['effect', 'preview'] },
  }, critics: [
    { id: 'holistic', title: 'Overall review', target: 'bundle', deps: [], kind: 'human' },
    { id: 'preview-check', title: 'Preview review', target: 'preview', deps: [], kind: 'runtime' },
    { id: 'publish-check', title: 'Publication review', target: 'published', deps: ['bundle'], kind: 'runtime' },
  ] };
  const artifacts = [{ id: 'effect', type: 'vfx', path: 'effect.vfx' }, { id: 'preview', type: 'image', path: 'preview.png' }];
  const requests = graph.critics.map(critic => f.request(critic.id, {
    runId: 'group-run', snapshotHash: hash, criticId: critic.id, target: critic.target, deps: critic.deps,
    status: critic.id === 'preview-check' ? 'RED' : 'GREEN', profile: critic.kind === 'human' ? { kind: 'human' } : { kind: 'runtime', command: 'node', args: ['--test', 'test.mjs'] },
    artifacts: critic.id === 'preview-check' ? [artifacts[1]] : critic.id === 'publish-check' ? [{ id: 'published', type: 'text', path: 'published.md' }, ...artifacts] : artifacts,
    ...(critic.id === 'preview-check' ? {} : { artifactGroups: [{ id: 'bundle', members: ['effect', 'preview'], ...{ privateData: 'GROUP_PRIVATE_SENTINEL' } }] }),
  }));
  const state = await f.state('group', requests, { runData: { 'group-run': { snapshotHash: hash, graph, scope: { kind: 'graph' } } } });
  const dbPath = path.join(state.stateDir, 'broker.sqlite'), before = await fs.readFile(dbPath);
  const store = createMonitorStore({ stateDirs: [state.stateDir] });
  const detail = present(await store.detail(state.id, 'holistic'));
  assert.deepEqual(detail.artifactGroups, [{ id: 'bundle', members: ['effect', 'preview'] }]);
  assert.doesNotMatch(JSON.stringify(detail), /GROUP_PRIVATE_SENTINEL/);
  const projection = present((await store.graph(state.id, 'group-run'))?.graph);
  const bundle = present(projection.artifacts.find(artifact => artifact.id === 'bundle'));
  assert.equal(bundle.kind, 'group');
  assert.deepEqual(bundle.kind === 'group' ? bundle.members : null, ['effect', 'preview']);
  assert.equal(bundle.status, 'GREEN');
  assert.equal(projection.artifacts.find(artifact => artifact.id === 'preview')?.status, 'RED');
  assert.equal(projection.artifacts.find(artifact => artifact.id === 'effect')?.status, 'UNREVIEWED');
  assert.deepEqual(projection.edges, [{ source: 'bundle', target: 'published', criticIds: ['publish-check'] }]);
  assert.deepEqual(await fs.readFile(dbPath), before, 'Observation must leave the database unchanged');
  await assert.rejects(fs.stat(state.repoPath), { code: 'ENOENT' });
});

test('group detail rejects cyclic and out-of-scope saved composition while retaining legacy records', async t => {
  const f = await fixture(t);
  const state = await f.state('invalid-groups', [
    f.request('legacy'),
    f.request('nested', { artifactGroups: [{ id: 'outer', members: ['inner', 'spec'] }, { id: 'inner', members: ['spec'] }] }),
    f.request('outside', { artifactGroups: [{ id: 'bundle', members: ['other'] }] }),
    f.request('cycle', { artifactGroups: [{ id: 'first', members: ['second'] }, { id: 'second', members: ['first'] }] }),
    f.request('duplicate', { artifactGroups: [{ id: 'bundle', members: ['spec', 'spec'] }] }),
  ]);
  const store = createMonitorStore({ stateDirs: [state.stateDir] });
  assert.equal((await store.detail(state.id, 'legacy'))?.artifactGroups, undefined);
  assert.equal((await store.detail(state.id, 'nested'))?.artifactGroups?.length, 2);
  for (const id of ['outside', 'cycle', 'duplicate']) assert.equal(await store.detail(state.id, id), null);
});

const graphDefinition = (): GraphDefinition => ({
  version: 1,
  artifacts: { why: { type: 'text', path: 'why.md', basis: true }, spec: { type: 'text', path: 'spec.md' }, tests: { type: 'code', path: 'tests' }, implementation: { type: 'code', path: 'src' }, unused: { type: 'text', path: 'notes.md' } },
  critics: [
    { id: 'spec-agent', title: 'Check Spec intent', kind: 'agent', target: 'spec', deps: ['why'] },
    { id: 'spec-human', title: 'Human Spec review', kind: 'human', target: 'spec', deps: ['why'] },
    { id: 'tests', title: 'Check Tests', kind: 'runtime', target: 'tests', deps: ['spec'] },
    { id: 'implementation', title: 'Check implementation', kind: 'runtime', target: 'implementation', deps: ['spec', 'tests'] },
  ],
});

test('run-scoped graph includes all declarations and never borrows passes from other runs or snapshots', async t => {
  const f = await fixture(t), graph = graphDefinition(), firstHash = 'a'.repeat(64), secondHash = 'b'.repeat(64);
  const request = (runId: string, criticId: string, status: ReviewRequest['status'], hash = firstHash): StoredRequest => {
    const critic = present(graph.critics.find(item => item.id === criticId));
    return f.request(`${runId}-${criticId}`, { runId, criticId, target: critic.target, deps: critic.deps, snapshotHash: hash, status, profile: critic.kind === 'human' ? { kind: 'human' } : critic.kind === 'agent' ? { kind: 'agent', provider: 'safe-provider', model: 'safe-model', reasoning: 'medium' } : { kind: 'runtime', command: 'node', args: [] } });
  };
  const rows = [
    request('full', 'spec-agent', 'GREEN'), { ...request('full', 'spec-human', 'WAITING_HUMAN'), claimedBy: 'browser-person', claimedAt: at(2), notifiedAt: at(1) }, request('full', 'tests', 'BLOCKED'), request('full', 'implementation', 'BLOCKED'),
    request('partial', 'spec-agent', 'GREEN'), request('other', 'spec-human', 'GREEN', secondHash),
  ];
  const state = await f.state('graph', rows, { runData: {
    full: { snapshotHash: firstHash, graph, scope: { kind: 'graph' }, privateRunPayload: 'RUN_PRIVATE_SENTINEL' },
    partial: { snapshotHash: firstHash, graph, scope: { kind: 'critic', criticId: 'spec-agent' } },
    other: { snapshotHash: secondHash, graph, scope: { kind: 'critic', criticId: 'spec-human' } },
  } });
  const otherProject = await f.state('other-project', [request('full', 'spec-human', 'RED')], { runData: { full: { snapshotHash: firstHash, graph } } });
  const store = createMonitorStore({ stateHome: f.stateHome });
  const before = await fs.readFile(path.join(state.stateDir, 'broker.sqlite'));
  const full = present(await store.graph(state.id, 'full'));
  assert.equal(full.available, true, full.unavailableReason ?? '');
  assert.equal(full.run.snapshotHash, firstHash);
  assert.equal(full.requests.length, 4);
  const spec = present(full.graph?.artifacts.find(item => item.id === 'spec'));
  assert.deepEqual({ status: spec.status, passed: spec.passed, total: spec.total, included: spec.included }, { status: 'WAITING_HUMAN', passed: 1, total: 2, included: 2 });
  assert.equal(full.graph?.critics.find(item => item.id === 'spec-human')?.claimedBy, 'browser-person');
  assert.equal(full.graph?.artifacts.find(item => item.id === 'why')?.status, 'BASIS');
  assert.equal(full.graph?.artifacts.find(item => item.id === 'unused')?.status, 'UNREVIEWED');
  assert.ok(full.graph?.edges.some(edge => edge.source === 'spec' && edge.target === 'implementation'));
  const partial = present(await store.graph(state.id, 'partial'));
  const partialSpec = present(partial.graph?.artifacts.find(item => item.id === 'spec'));
  assert.deepEqual({ status: partialSpec.status, passed: partialSpec.passed, total: partialSpec.total, included: partialSpec.included }, { status: 'UNREVIEWED', passed: 1, total: 2, included: 1 });
  assert.equal(partial.graph?.critics.length, 4);
  assert.equal(partial.graph?.critics.find(item => item.id === 'spec-human')?.requestId, null);
  assert.equal(partial.graph?.critics.find(item => item.id === 'spec-human')?.status, null);
  assert.equal((await store.graph(otherProject.id, 'full'))?.graph?.artifacts.find(item => item.id === 'spec')?.status, 'RED');
  const board = await store.overview({ project: state.id, run: 'partial', lane: 'success' });
  assert.equal(board.total, 1);
  assert.equal(board.requests[0].runId, 'partial');
  assert.deepEqual(board.laneCounts, { requested: 0, running: 0, success: 1, failure: 0 });
  await assert.rejects(store.overview({ run: 'full' }));
  const runs = await store.runs({ project: state.id, limit: 2 });
  assert.equal(runs.total, 3); assert.equal(runs.runs.length, 2); assert.equal(runs.hasMore, true);
  assert.equal((await store.runs({ project: state.id, limit: 2, offset: 2 })).runs.length, 1);
  assert.ok(runs.runs.every(item => item.graphAvailable));
  assert.doesNotMatch(JSON.stringify({ full, partial, runs }), /RUN_PRIVATE_SENTINEL|payload-secret|owner-token-secret|metadata-secret|privatePayload|profile|authFile/);
  assert.deepEqual(await fs.readFile(path.join(state.stateDir, 'broker.sqlite')), before);
});

test('historical or inconsistent graph metadata remains explicit unavailable without inspecting current source', async t => {
  const f = await fixture(t), graph = graphDefinition(), hash = 'a'.repeat(64);
  const historical = f.request('old', { runId: 'legacy' });
  const invalidSnapshot = f.request('mismatch', { runId: 'mismatch', criticId: 'tests', target: 'tests', deps: ['spec'], snapshotHash: 'b'.repeat(64) });
  const invalidTarget = f.request('scope', { runId: 'scope', criticId: 'tests', target: 'implementation', deps: ['spec'], snapshotHash: hash });
  const state = await f.state('history', [historical, invalidSnapshot, invalidTarget], { runData: { mismatch: { snapshotHash: hash, graph }, scope: { snapshotHash: hash, graph } } });
  const store = createMonitorStore({ stateDirs: [state.stateDir] });
  const old = present(await store.graph(state.id, 'legacy'));
  assert.equal(old.available, false); assert.equal(old.graph, null); assert.match(old.unavailableReason ?? '', /no stored Artifact graph definition/);
  assert.equal(old.requests.length, 1);
  for (const run of ['mismatch', 'scope']) {
    const result = present(await store.graph(state.id, run));
    assert.equal(result.available, false); assert.equal(result.graph, null); assert.match(result.unavailableReason ?? '', /does not match/);
  }
  assert.equal(await store.graph(state.id, 'unknown'), null);
  assert.equal(await store.graph('unknown', 'legacy'), null);
  assert.equal((await store.runs()).runs.find(run => run.id === 'legacy')?.graphAvailable, false);
  // No source directory was ever created; graph observation uses only persisted metadata.
  await assert.rejects(fs.stat(state.repoPath));
});

test('DAG failure attention follows all dependency artifacts and remains inside the selected run', async t => {
  const f = await fixture(t);
  const state = await f.state('dag', [
    f.request('a-green', { runId: 'dag', criticId: 'a-green', target: 'a', deps: [], status: 'GREEN' }),
    f.request('a-red', { runId: 'dag', criticId: 'a-red', target: 'a', deps: [], status: 'RED' }),
    f.request('b', { runId: 'dag', target: 'b', deps: [], status: 'GREEN' }),
    f.request('join', { runId: 'dag', target: 'join', deps: ['a', 'b'], status: 'BLOCKED' }),
    f.request('downstream', { runId: 'dag', target: 'final', deps: ['join'], status: 'BLOCKED' }),
    f.request('unrelated', { runId: 'dag', target: 'independent', deps: [], status: 'QUEUED' }),
    f.request('other-join', { runId: 'other', target: 'join', deps: ['a', 'b'], status: 'BLOCKED' }),
  ]);
  const store = createMonitorStore({ stateDirs: [state.stateDir] });
  const overview = await store.overview({ project: state.id, run: 'dag' });
  for (const id of ['join', 'downstream']) {
    const row = present(overview.requests.find(request => request.id === id));
    assert.equal(row.blockedByFailure, true); assert.match(row.waitingReason ?? '', /a-red/);
  }
  assert.equal(overview.requests.find(request => request.id === 'unrelated')?.blockedByFailure, false);
  assert.equal((await store.overview({ project: state.id, run: 'other' })).requests[0].blockedByFailure, false);
  assert.deepEqual(overview.counts, { all: 6, active: 1, attention: 3 });
});
