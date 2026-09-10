import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createBroker, readStateContext, type BrokerOptions, type BrokerExecutors, type RunView } from '../src/broker/index.js';
import { prepareReviewRequests } from '../src/requester/index.js';
import { fingerprintWorkspace, removeOwnedWorkspaceTree, prepareWorkspace, reopenWorkspace } from '../src/workspaces/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import type { RepoConfig, ReviewRequest, ExecutionContext, ReviewResult } from '../src/contracts.js';

type Broker = ReturnType<typeof createBroker>;
type ExecutionCall = { request: ReviewRequest; context: ExecutionContext & { signal: AbortSignal } };
const present = <T>(value: T | null | undefined): T => { assert.ok(value != null); return value; };

const green: ReviewResult = { verdict: 'GREEN', summary: 'The workspace meets its criterion.', evidence: ['Checked the submitted artifact.'] };
const red: ReviewResult = { verdict: 'RED', summary: 'The criterion is not met.', evidence: ['The expected value differs.'] };
const defaults = (): RepoConfig => ({
  artifacts: { why: { type: 'markdown', path: 'why.md', basis: true }, spec: { type: 'markdown', path: 'spec.md' }, tests: { type: 'code', path: 'tests' }, implementation: { type: 'code', path: 'implementation' } },
    artifactTypes: { markdown: { viewer: 'text', agentTools: { read: {} }, humanTools: { read: {} } }, code: { viewer: 'files', agentTools: { list: {}, read: {} }, humanTools: { list: {}, read: {} } } },
  critics: [
    { id: 'spec-why', title: 'Spec / Why', target: 'spec', deps: ['why'], profile: { kind: 'agent', provider: 'test', model: 'test', reasoning: 'medium' }, payload: { instruction: 'Compare {why} and {spec}.' } },
    { id: 'tests-spec', title: 'Tests / Spec', target: 'tests', deps: ['spec'], profile: { kind: 'agent', provider: 'test', model: 'test', reasoning: 'medium' }, payload: { instruction: 'Compare {spec} and {tests}.' } },
    { id: 'implementation-tests', title: 'Runtime', target: 'implementation', deps: ['tests'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/example.test.mjs'] }, payload: { instruction: 'Execute tests.' } },
  ],
});

test('Human tools require the active claimant, read the snapshot, and never submit a verdict', async t => {
  const config = defaults();
  config.critics[0].profile = { kind: 'human' };
  const { repoPath, open } = await fixture(t, config);
  const broker = open(createExecutorRegistry({ alarmMethods: [async () => {}] }));
  const run = await broker.submit({ requesterId: 'builder', criticId: 'spec-why' });
  await broker.run(run.id);
  const requestId = run.requests[0].id;
  await assert.rejects(broker.executeHumanTool(requestId, { reviewerId: 'alice', toolName: 'read_why' }), /reviewer who claimed/);
  await broker.claimHuman(requestId, 'alice');
  await assert.rejects(broker.executeHumanTool(requestId, { reviewerId: 'bob', toolName: 'read_why' }), /reviewer who claimed/);
  await fs.writeFile(path.join(repoPath, 'why.md'), 'Builder has a newer version.');
  const result = await broker.executeHumanTool(requestId, { reviewerId: 'alice', toolName: 'read_why' });
  assert.ok('content' in result);
  assert.equal(result.content, 'Current workspace purpose.');
  const waiting = broker.getRequest(requestId);
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(waiting.result, null);
  assert.ok(broker.getRun(run.id).events.some(event => event.type === 'human.tool.executed'));
  await assert.rejects(broker.executeHumanTool(requestId, { reviewerId: 'alice', toolName: 'read_why', arguments: { path: '../outside' } }), /argument/);
  assert.equal(broker.getRequest(requestId).status, 'WAITING_HUMAN');
  await broker.completeHuman(requestId, { reviewerId: 'alice', result: green });
  await assert.rejects(broker.executeHumanTool(requestId, { reviewerId: 'alice', toolName: 'read_why' }), /not waiting/);
});

test('Human tools reject a changed copy without executing and preserve ERROR separately from a verdict', async t => {
  const config = defaults();
  config.critics[0].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const broker = open(createExecutorRegistry({ alarmMethods: [async () => {}] }));
  const run = await broker.submit({ requesterId: 'builder', criticId: 'spec-why' });
  await broker.run(run.id);
  const requestId = run.requests[0].id;
  await broker.claimHuman(requestId, 'alice');
  const target = path.join(run.workspace.path, 'why.md');
  await fs.chmod(target, 0o600);
  await fs.writeFile(target, 'Tampered input');
  await assert.rejects(broker.executeHumanTool(requestId, { reviewerId: 'alice', toolName: 'read_why' }), /changed|tampered/i);
  assert.equal(broker.getRequest(requestId).status, 'ERROR');
  assert.equal(broker.getRequest(requestId).result, null);
  assert.equal(broker.getRun(run.id).events.some(event => event.type === 'human.tool.executed'), false);
});

test('a Human program that mutates its reviewed Artifact invalidates the review during launch', async t => {
  const config = defaults();
  config.critics[0].profile = { kind: 'human' };
  config.artifactTypes.markdown.humanTools!.open = {
    description: 'Open {artifactName}', command: process.execPath,
    args: ['-e', "require('node:fs').chmodSync(process.argv[1],384);require('node:fs').writeFileSync(process.argv[1],'modified');setTimeout(()=>process.exit(0),1000)", '{artifactPath}'],
  };
  const { open } = await fixture(t, config);
  const broker = open(createExecutorRegistry({ alarmMethods: [async () => {}] }));
  const run = await broker.submit({ requesterId: 'builder', criticId: 'spec-why' });
  await broker.run(run.id);
  const requestId = run.requests[0].id;
  await broker.claimHuman(requestId, 'alice');
  await assert.rejects(broker.executeHumanTool(requestId, { reviewerId: 'alice', toolName: 'open_why' }));
  assert.equal(broker.getRequest(requestId).status, 'ERROR');
  assert.equal(broker.getRequest(requestId).result, null);
  assert.equal(broker.getRun(run.id).events.some(event => event.type === 'human.tool.executed'), false);
});
const registry = (execute: BrokerExecutors['execute']): BrokerExecutors => ({ canExecute: () => ({ ok: true }), execute });

async function fixture(t: TestContext, config = defaults()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdd-broker-test-'));
  const repoPath = path.join(dir, 'repo');
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(path.join(repoPath, 'tests'), { recursive: true });
  await fs.mkdir(path.join(repoPath, 'implementation'));
  await fs.writeFile(path.join(repoPath, 'why.md'), 'Current workspace purpose.');
  await fs.writeFile(path.join(repoPath, 'spec.md'), 'Current workspace specification.');
  await fs.writeFile(path.join(repoPath, 'tests/example.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { answer } from '../implementation/example.mjs'; test('answer meets the criterion', () => assert.equal(answer, 42));");
  await fs.writeFile(path.join(repoPath, 'implementation/example.mjs'), 'export const answer = 42;');
  const setConfig = async (next = config) => fs.writeFile(path.join(repoPath, 'ccdd.config.json'), JSON.stringify(next));
  await setConfig();
  const brokers: Broker[] = [];
  const open = (executors?: BrokerExecutors, options: Partial<BrokerOptions> = {}) => {
    const broker = createBroker({ repoPath, stateDir, executors, ...options });
    brokers.push(broker);
    return { ...broker,
      getRun: (id: string) => present(broker.getRun(id)),
      getRequest: (id: string) => present(broker.getRequest(id)),
      cancel: (id: string) => present(broker.cancel(id)),
    };
  };
  t.after(async () => { for (const broker of brokers) await broker.close(); await removeOwnedWorkspaceTree(dir); });
  return { dir, repoPath, stateDir, setConfig, open };
}

async function until<T>(read: () => T, check: (value: T) => unknown, timeout = 10_000): Promise<T> {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) { const value = read(); if (check(value)) return value; await delay(10); }
  throw new Error(`Timed out waiting for broker state: ${JSON.stringify(read())}`);
}

function abortableGate(signal: AbortSignal) {
  return new Promise<never>((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('submission persists a handle without executing; a separate broker runs the copied current workspace sequentially', async t => {
  const { repoPath, open } = await fixture(t);
  await fs.writeFile(path.join(repoPath, 'untracked.txt'), 'New input without any Git repository or commit.');
  const calls: ExecutionCall[] = [];
  const executors = registry(async (request, context) => {
    calls.push({ request, context });
    assert.equal(await fs.readFile(path.join(context.worktreePath, 'why.md'), 'utf8'), 'Current workspace purpose.');
    assert.equal(await fs.readFile(path.join(context.worktreePath, 'untracked.txt'), 'utf8'), 'New input without any Git repository or commit.');
    assert.ok(!context.runDir.startsWith(context.worktreePath));
    return green;
  });
  const submitter = open(executors);
  const record = await submitter.submit({ requesterId: 'builder', mode: 'copy' });
  assert.equal(record.status, 'QUEUED');
  assert.deepEqual(record.scope, { kind: 'graph' });
  assert.deepEqual(record.requests.map(request => request.status), ['QUEUED', 'BLOCKED', 'BLOCKED']);
  assert.equal(calls.length, 0);
  await submitter.close();
  await fs.writeFile(path.join(repoPath, 'why.md'), 'Builder can immediately continue editing the original.');
  const reader = open();
  assert.equal(reader.getRun(record.id).status, 'QUEUED');
  const worker = open(executors);
  await worker.run(record.id);
  const completed = reader.getRun(record.id);
  assert.equal(completed.status, 'GREEN', JSON.stringify(completed));
  assert.deepEqual(calls.map(call => call.request.criticId), ['spec-why', 'tests-spec', 'implementation-tests']);
  assert.equal(new Set(calls.map(call => call.context.worktreePath)).size, 1);
  assert.equal(new Set(calls.map(call => call.context.runDir)).size, 3);
  assert.equal(completed.requests[1].predecessorId, undefined);
  assert.deepEqual(completed.requests[1].deps, ['spec']);
  assert.equal(completed.requests[0].snapshotHash, completed.workspace.hash);
  assert.equal(completed.owner, null);
  assert.ok(completed.events.some(event => event.type === 'workspace.ready'));
  assert.equal(reader.listRuns()[0].id, completed.id);
});

test('same content shares one copied workspace across concurrent reviews while requests and output directories remain independent', async t => {
  const { open } = await fixture(t);
  const entered: ExecutionCall[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executors = registry(async (request, context) => { entered.push({ request, context }); await gate; return green; });
  const first = open(executors);
  const second = open(executors);
  const [one, two] = await Promise.all([
    first.submit({ requesterId: 'one', criticId: 'spec-why' }),
    second.submit({ requesterId: 'two', criticId: 'tests-spec' }),
  ]);
  assert.equal(one.workspace.hash, two.workspace.hash);
  assert.equal(one.workspace.path, two.workspace.path);
  assert.notEqual(one.id, two.id);
  const running = [first.run(one.id), second.run(two.id)];
  await until(() => entered.length, value => value === 2);
  assert.notEqual(entered[0].context.runDir, entered[1].context.runDir);
  assert.equal(entered[0].context.worktreePath, entered[1].context.worktreePath);
  release(); await Promise.all(running);
  assert.equal(first.getRun(one.id).status, 'GREEN');
  assert.equal(second.getRun(two.id).status, 'GREEN');
});

test('selected Runtime Critic works without unrelated Agent availability and executes actual uncommitted changes', async t => {
  const { repoPath, open } = await fixture(t);
  const actual = createExecutorRegistry();
  const checks: string[] = [];
  const broker = open({ canExecute: request => { checks.push(request.criticId); return actual.canExecute(request); }, execute: (request, context) => actual.execute(request, context) });
  await assert.rejects(broker.submit({ requesterId: 'builder' }), /Cannot execute spec-why: .*Pi Provider/);
  assert.deepEqual(broker.listRuns(), []);
  checks.length = 0;
  const initial = await broker.submit({ requesterId: 'builder', criticId: 'implementation-tests' });
  await broker.run(initial.id);
  const completed = broker.getRun(initial.id);
  assert.equal(completed.status, 'GREEN', JSON.stringify(completed));
  assert.deepEqual(completed.scope, { kind: 'critic', criticId: 'implementation-tests' });
  assert.equal(completed.requests.length, 1);
  assert.equal(completed.requests[0].target, 'implementation');
  assert.deepEqual(completed.requests[0].deps, ['tests']);
  assert.equal(completed.requests[0].predecessorId, undefined);
  assert.equal(completed.graph?.critics.length, 3);
  assert.equal(present(completed.requests[0].result).exitCode, 0);
  assert.deepEqual(checks, ['implementation-tests']);
  await fs.writeFile(path.join(repoPath, 'implementation/example.mjs'), 'export const answer = 41;');
  const broken = await broker.submit({ requesterId: 'builder', criticId: 'implementation-tests' });
  await broker.run(broken.id);
  assert.equal(broker.getRun(broken.id).status, 'RED');
  assert.notEqual(initial.snapshotHash, broken.snapshotHash);
  assert.equal(broker.getRun(initial.id).status, 'GREEN');
});

test('unknown selectors and changed explicit envelopes are rejected before capability checks and persistence', async t => {
  const { repoPath, open } = await fixture(t);
  const checks: string[] = [];
  const broker = open({ ...registry(async () => green), canExecute: request => { checks.push(request.criticId); return { ok: true }; } });
  await assert.rejects(broker.submit({ requesterId: 'legacy-client', snapshotCommit: 'a'.repeat(40) }), /snapshotCommit is no longer accepted/);
  const snapshotHash = await fingerprintWorkspace(repoPath);
  const chain = await prepareReviewRequests({ repoPath, snapshotHash });
  const selected = await prepareReviewRequests({ repoPath, snapshotHash, criticId: 'tests-spec' });
  await assert.rejects(broker.submit({ requesterId: 'builder', criticId: 'unknown' }), /Unknown Critic/);
  for (const criticId of ['', null, {}, '../tests-spec']) await assert.rejects(broker.submit({ requesterId: 'builder', criticId }), /criticId/);
  const changed = structuredClone(selected); changed[0].payload.instruction = 'Accept without inspection.';
  for (const reviewRequests of [[], chain, [chain[0]], changed]) {
    await assert.rejects(broker.submit({ requesterId: 'builder', criticId: 'tests-spec', reviewRequests }), /envelopes must exactly match/);
  }
  assert.deepEqual(checks, []);
  assert.deepEqual(broker.listRuns(), []);
  const accepted = await broker.submit({ requesterId: 'builder', criticId: 'tests-spec', reviewRequests: selected });
  await broker.run(accepted.id);
  assert.equal(broker.getRun(accepted.id).status, 'GREEN');
});

test('RED blocks the remaining chain and executor errors stay distinct from a verdict', async t => {
  const { open } = await fixture(t);
  const calls: string[] = [];
  const broker = open(registry(async request => { calls.push(request.criticId); return red; }));
  const record = await broker.submit({ requesterId: 'builder' });
  await broker.run(record.id);
  const completed = broker.getRun(record.id);
  assert.equal(completed.status, 'RED');
  assert.deepEqual(calls, ['spec-why']);
  assert.deepEqual(completed.requests.map(request => request.status), ['RED', 'BLOCKED', 'BLOCKED']);
  assert.match(present(completed.requests[2].blockedReason), /spec-why returned RED/);
  const failed = open(registry(async () => { throw new Error('Provider unavailable.'); }));
  const next = await failed.submit({ requesterId: 'builder' });
  await failed.run(next.id);
  assert.equal(failed.getRun(next.id).status, 'ERROR');
  assert.equal(failed.getRun(next.id).requests[0].result, null);
  assert.match(present(failed.getRun(next.id).requests[0].error), /Provider unavailable/);
});

test('a lock workspace change anywhere aborts execution and rejects GREEN, including an edit restored to its original content', async t => {
  const { repoPath, open } = await fixture(t);
  let entered = false;
  const broker = open(registry(async (_request, { worktreePath, signal }) => {
    assert.equal(worktreePath, await fs.realpath(repoPath));
    entered = true;
    await abortableGate(signal);
    return green;
  }));
  const record = await broker.submit({ mode: 'lock', requesterId: 'builder' });
  const running = broker.run(record.id);
  await until(() => entered, Boolean);
  const outsideArtifacts = path.join(repoPath, 'new-file.txt');
  await fs.writeFile(outsideArtifacts, 'temporary'); await fs.unlink(outsideArtifacts);
  await running;
  const failed = broker.getRun(record.id);
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.requests[0].errorCode, 'WORKSPACE_CHANGED');
  assert.equal(failed.requests[0].result, null);
});

test('a changed lock workspace between submission and worker start fails before any executor runs', async t => {
  const { repoPath, open } = await fixture(t);
  let calls = 0;
  const broker = open(registry(async () => { calls += 1; return green; }));
  const record = await broker.submit({ mode: 'lock', requesterId: 'builder' });
  const file = path.join(repoPath, 'why.md');
  await fs.writeFile(file, 'changed'); await fs.writeFile(file, 'Current workspace purpose.');
  await broker.run(record.id);
  assert.equal(broker.getRun(record.id).status, 'ERROR');
  assert.equal(calls, 0);
});

test('tampering with shared copied inputs invalidates all active reviews instead of caching verdicts', async t => {
  const { open } = await fixture(t);
  let started = 0;
  const executors = registry(async (_request, { signal }) => { started += 1; await abortableGate(signal); return green; });
  const one = open(executors); const two = open(executors);
  const first = await one.submit({ requesterId: 'one', criticId: 'spec-why' });
  const second = await two.submit({ requesterId: 'two', criticId: 'tests-spec' });
  const running = [one.run(first.id), two.run(second.id)];
  await until(() => started, value => value === 2);
  await fs.chmod(path.join(first.workspace.path, 'why.md'), 0o644);
  await Promise.all(running);
  for (const record of [one.getRun(first.id), two.getRun(second.id)]) {
    assert.equal(record.status, 'ERROR');
    assert.equal(record.requests[0].errorCode, 'WORKSPACE_CACHE_TAMPERED');
  }
});

test('opening or closing a read-only broker leaves active work intact and a duplicate owner cannot execute it', async t => {
  const { open } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const executors = registry(async () => { entered = true; await gate; return green; });
  const worker = open(executors);
  const record = await worker.submit({ requesterId: 'builder', criticId: 'tests-spec' });
  const executing = worker.run(record.id);
  await until(() => entered, Boolean);
  const other = open(executors);
  assert.equal(other.getRun(record.id).status, 'RUNNING');
  await assert.rejects(other.run(record.id), { code: 'RUN_ALREADY_OWNED' });
  await other.close();
  const reader = open();
  assert.equal(reader.getRun(record.id).status, 'RUNNING');
  release(); await executing;
  assert.equal(reader.getRun(record.id).status, 'GREEN');
});

test('Human copy wait persists without a worker and separate clients claim, complete and resume the chain', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const notifications: string[] = []; const executed: string[] = [];
  const executors = { ...registry(async request => { executed.push(request.criticId); return green; }), notifyHuman: async (request: ReviewRequest) => notifications.push(request.id) };
  const worker = open(executors);
  const record = await worker.submit({ requesterId: 'builder' });
  await worker.run(record.id);
  const waiting = worker.getRun(record.id);
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(waiting.owner, null);
  assert.deepEqual(notifications, [waiting.requests[0].id]);
  await worker.close();
  const alice = open(); const bob = open();
  const requestId = waiting.requests[0].id;
  await assert.rejects(alice.completeHuman(requestId, { reviewerId: 'alice', result: green }), /claimed/);
  await alice.claimHuman(requestId, 'alice');
  await assert.rejects(bob.claimHuman(requestId, 'bob'), /another reviewer/);
  await assert.rejects(bob.completeHuman(requestId, { reviewerId: 'bob', result: green }), /claimed/);
  const completions = await Promise.allSettled([
    alice.completeHuman(requestId, { reviewerId: 'alice', result: green }),
    bob.completeHuman(requestId, { reviewerId: 'alice', result: red }),
  ]);
  assert.equal(completions.filter(value => value.status === 'fulfilled').length, 1);
  const winner = alice.getRequest(requestId);
  if (winner.status === 'GREEN') {
    assert.equal(alice.getRun(record.id).status, 'QUEUED');
    const resume = open(executors); await resume.run(record.id);
    assert.equal(alice.getRun(record.id).status, 'GREEN');
    assert.deepEqual(executed, ['tests-spec', 'implementation-tests']);
  } else {
    assert.equal(alice.getRun(record.id).status, 'RED');
    assert.deepEqual(executed, []);
  }
  assert.equal(notifications.length, 1);
});

test('Human lock wait keeps its monitoring worker and rejects changes during the wait', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { repoPath, open } = await fixture(t, config);
  const worker = open({ ...registry(async () => green), notifyHuman: async () => {} });
  const record = await worker.submit({ mode: 'lock', requesterId: 'builder' });
  const running = worker.run(record.id);
  const waiting = await until(() => worker.getRun(record.id), value => value.requests[0].notifiedAt);
  assert.equal(waiting.status, 'WAITING_HUMAN');
  assert.equal(present(waiting.owner).pid, process.pid);
  const reviewer = open(); await reviewer.claimHuman(waiting.requests[0].id, 'alice');
  await fs.writeFile(path.join(repoPath, 'spec.md'), 'Changed while Human was reading.');
  await running;
  assert.equal(reviewer.getRun(record.id).status, 'ERROR');
  await assert.rejects(reviewer.completeHuman(waiting.requests[0].id, { reviewerId: 'alice', result: green }), /not waiting/);
});

test('Human lock completion can arrive through another broker while the original worker continues the chain', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const worker = open({ ...registry(async () => green), notifyHuman: async () => {} });
  const record = await worker.submit({ mode: 'lock', requesterId: 'builder' });
  const running = worker.run(record.id);
  const waiting = await until(() => worker.getRun(record.id), value => value.requests[0].notifiedAt);
  const reviewer = open(); await reviewer.claimHuman(waiting.requests[0].id, 'alice');
  await reviewer.completeHuman(waiting.requests[0].id, { reviewerId: 'alice', result: green });
  await running;
  assert.equal(reviewer.getRun(record.id).status, 'GREEN');
});

test('Human alarm registration and actual delivery are required and failed delivery never records notified', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const noAlarm = open(registry(async () => green));
  await assert.rejects(noAlarm.submit({ requesterId: 'builder' }), /alarm method/);
  const worker = open({ ...registry(async () => green), notifyHuman: async () => { throw new Error('Alarm delivery failed.'); } });
  const record = await worker.submit({ requesterId: 'builder' });
  await worker.run(record.id);
  const failed = worker.getRun(record.id);
  assert.equal(failed.status, 'ERROR');
  assert.match(present(failed.requests[0].error), /Alarm delivery failed/);
  assert.equal(failed.events.some(event => event.type === 'human.notified'), false);
});

test('cancel from a separate client aborts the owner without affecting other Runs', async t => {
  const { open } = await fixture(t);
  let started = false;
  const worker = open(registry(async (_request, { signal }) => { started = true; await abortableGate(signal); return green; }));
  const first = await worker.submit({ requesterId: 'one', criticId: 'spec-why' });
  const second = await worker.submit({ requesterId: 'two', criticId: 'spec-why' });
  const running = worker.run(first.id);
  await until(() => started, Boolean);
  const client = open();
  assert.equal(client.cancel(first.id).status, 'ERROR');
  await running;
  assert.equal(client.getRun(first.id).requests[0].errorCode, 'REVIEW_CANCELED');
  assert.equal(client.getRun(second.id).status, 'QUEUED');
  client.failRun(second.id, new Error('Cannot launch the review worker.'));
  assert.match(present(client.getRun(second.id).requests[0].error), /Cannot launch/);
});

test('closing the executing broker aborts only its owned Run and preserves unrelated queued work', async t => {
  const { open } = await fixture(t);
  let started = false;
  const worker = open(registry(async (_request, { signal }) => { started = true; await abortableGate(signal); }));
  const first = await worker.submit({ requesterId: 'one', criticId: 'spec-why' });
  const second = await worker.submit({ requesterId: 'two', criticId: 'spec-why' });
  const running = worker.run(first.id);
  await until(() => started, Boolean);
  await worker.close(); await running;
  const reader = open();
  assert.equal(reader.getRun(first.id).status, 'ERROR');
  assert.equal(reader.getRun(second.id).status, 'QUEUED');
});

test('a crashed separate worker is reconciled as ERROR while another client remains usable', async t => {
  const { repoPath, stateDir, open } = await fixture(t);
  const moduleUrl = new URL('../src/broker/index.js', import.meta.url).href;
  const script = `import {createBroker} from ${JSON.stringify(moduleUrl)};
    const broker=createBroker({repoPath:${JSON.stringify(repoPath)},stateDir:${JSON.stringify(stateDir)},executors:{canExecute:()=>({ok:true}),execute:async(_request,{signal})=>{process.stdout.write('EXECUTING\\n');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
    const record=await broker.submit({mode:'lock',requesterId:'crash-test'});
    process.stdout.write(record.id+'\\n');await broker.run(record.id);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  t.after(() => { child.kill('SIGKILL'); });
  await until(() => output, value => value.includes('EXECUTING')).catch(error => { throw new Error(`${error.message}\n${errors}`); });
  const runId = output.trim().split('\n')[0];
  const reader = open();
  assert.equal(reader.getRun(runId).status, 'RUNNING');
  await reader.close();
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  const reopened = open();
  const failed = reopened.getRun(runId);
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.requests[0].errorCode, 'WORKER_EXITED');
  assert.equal(failed.owner, null);
  assert.deepEqual(failed.requests.map(request => request.status), ['ERROR', 'ERROR', 'ERROR']);
});

test('completed legacy scope-less records are readable without replay and nested state is rejected without creating it', async t => {
  const { repoPath, stateDir, open } = await fixture(t);
  const broker = open(registry(async () => green));
  const record = await broker.submit({ requesterId: 'builder' }); await broker.run(record.id); await broker.close();
  const db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
  const stored = JSON.parse(String(present(db.prepare('SELECT data FROM runs WHERE id = ?').get(record.id)).data)) as Record<string, unknown>;
  delete stored.scope; delete stored.workspace; delete stored.graph;
  db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(JSON.stringify(stored), record.id); db.close();
  const reader = open();
  assert.equal(reader.getRun(record.id).status, 'GREEN');
  assert.deepEqual(reader.getRun(record.id).scope, { kind: 'chain' });
  const nested = path.join(repoPath, 'state', 'nested');
  assert.throws(() => createBroker({ repoPath, stateDir: nested }), /outside/);
  await assert.rejects(fs.stat(path.join(repoPath, 'state')), { code: 'ENOENT' });
});


test('Human completion during copied-input validation keeps the original owner executing its newly queued successor', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const reviewer = open();
  let record!: RunView;
  let paused = false;
  let entered!: () => void;
  const atValidation = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executors = { ...registry(async () => green), notifyHuman: async () => {} };
  const worker = open(executors, { workspaceAdapter: {
    prepareWorkspace,
    async reopenWorkspace(...args: Parameters<typeof reopenWorkspace>) {
      const workspace = await reopenWorkspace(...args);
      return { ...workspace, async assertUnchanged() {
        const state = record && reviewer.getRun(record.id);
        if (!paused && state?.status === 'WAITING_HUMAN' && state.requests[0].notifiedAt) {
          paused = true; entered(); await gate;
        }
        return workspace.assertUnchanged();
      } };
    },
  } });
  record = await worker.submit({ requesterId: 'builder' });
  let startCalls = 0;
  const running = worker.run(record.id, { onStarted: ({ runId, pid }) => {
    assert.equal(runId, record.id); assert.equal(pid, process.pid); startCalls += 1;
  } });
  await atValidation;
  await reviewer.claimHuman(record.requests[0].id, 'alice');
  await reviewer.completeHuman(record.requests[0].id, { reviewerId: 'alice', result: green });
  const competing = open(executors);
  await assert.rejects(competing.run(record.id, { onStarted: () => { startCalls += 1; } }), { code: 'RUN_ALREADY_OWNED' });
  release(); await running;
  assert.equal(reviewer.getRun(record.id).status, 'GREEN');
  assert.equal(startCalls, 1);
});

test('copy wait releases ownership before asynchronous cleanup, so an immediate Human response can start a new worker', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const reviewer = open();
  let record!: RunView;
  let held = false;
  let entered!: () => void;
  const atCleanup = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executors = { ...registry(async () => green), notifyHuman: async () => {} };
  const worker = open(executors, { workspaceAdapter: {
    prepareWorkspace,
    async reopenWorkspace(...args: Parameters<typeof reopenWorkspace>) {
      const workspace = await reopenWorkspace(...args);
      return { ...workspace, async close() {
        if (!held && reviewer.getRun(record.id).status === 'WAITING_HUMAN') { held = true; entered(); await gate; }
        await workspace.close();
      } };
    },
  } });
  record = await worker.submit({ requesterId: 'builder' });
  const waitingWorker = worker.run(record.id);
  await atCleanup;
  assert.equal(reviewer.getRun(record.id).owner, null);
  await reviewer.claimHuman(record.requests[0].id, 'alice');
  await reviewer.completeHuman(record.requests[0].id, { reviewerId: 'alice', result: green });
  const resumed = worker.run(record.id);
  release(); await Promise.all([waitingWorker, resumed]);
  assert.equal(reviewer.getRun(record.id).status, 'GREEN');
  assert.equal(reviewer.getRun(record.id).owner, null);
});

test('copied Human review and its successor remain usable after the original builder workspace is deleted', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { repoPath, stateDir, open } = await fixture(t, config);
  const executors = { ...registry(async () => green), notifyHuman: async () => {} };
  const initial = open(executors);
  const record = await initial.submit({ requesterId: 'temporary-builder' });
  await initial.run(record.id); await initial.close();
  const identity = readStateContext(stateDir);
  assert.equal(identity.repoPath, await fs.realpath(repoPath));
  assert.equal(identity.repoId, 'demo');
  await fs.rm(repoPath, { recursive: true });
  const reviewer = open();
  assert.equal(reviewer.getRun(record.id).status, 'WAITING_HUMAN');
  await reviewer.claimHuman(record.requests[0].id, 'alice');
  await reviewer.completeHuman(record.requests[0].id, { reviewerId: 'alice', result: green });
  const worker = open(executors); await worker.run(record.id);
  assert.equal(reviewer.getRun(record.id).status, 'GREEN');
  await assert.rejects(worker.submit({ requesterId: 'missing-source' }), { code: 'ENOENT' });
});


test('executor workspace validation rejects credentials in source before any snapshot is created', async t => {
  const config = defaults();
  config.critics[0].profile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-5.6-sol', reasoning: 'medium' };
  const { repoPath, stateDir, open } = await fixture(t, config);
  const authFile = path.join(repoPath, 'auth.json');
  const secret = 'test-credential-never-copied-to-review-state';
  await fs.writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'api_key', key: secret } }));
  const executors = createExecutorRegistry({ piOptions: { authFile } });
  let prepared = false;
  const broker = open(executors, { workspaceAdapter: {
    async prepareWorkspace(...args: Parameters<typeof prepareWorkspace>) {
      prepared = true;
      return prepareWorkspace(...args);
    },
    reopenWorkspace,
  } });
  await assert.rejects(broker.submit({ requesterId: 'builder', criticId: 'spec-why' }), { code: 'AUTHENTICATION_IN_WORKSPACE' });
  assert.equal(prepared, false);
  assert.deepEqual(broker.listRuns(), []);
  await assert.rejects(fs.stat(path.join(stateDir, 'workspaces')), { code: 'ENOENT' });
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function branchConfig(): RepoConfig {
  const config = defaults();
  config.critics = [
    { ...config.critics[2], id: 'join', target: 'implementation', deps: ['spec', 'tests'] },
    { ...config.critics[1], id: 'right', target: 'tests', deps: ['why'] },
    { ...config.critics[0], id: 'left', target: 'spec', deps: ['why'] },
  ];
  return config;
}

test('unordered DAG starts independent Critics together and joins only after every evaluator of every dependency is GREEN', async t => {
  const config = branchConfig();
  config.critics.push({ ...config.critics[2], id: 'left-second' });
  const { open } = await fixture(t, config);
  const holds = new Map(['left', 'left-second', 'right'].map(id => [id, gate<ReviewResult>()]));
  const started: string[] = [];
  const broker = open(registry(async (request, { signal }) => {
    started.push(request.criticId);
    const hold = holds.get(request.criticId);
    return hold ? Promise.race([hold.promise, abortableGate(signal)]) : green;
  }));
  const run = await broker.submit({ requesterId: 'dag-builder' });
  assert.deepEqual(run.requests.map(request => request.status), ['BLOCKED', 'QUEUED', 'QUEUED', 'QUEUED']);
  assert.deepEqual(run.events.filter(event => event.type === 'request.queued').map(event => event.requestId), run.requests.slice(1).map(request => request.id));
  assert.equal(run.graph?.critics.length, 4);
  assert.deepEqual(run.requests[0].artifacts.map(artifact => artifact.id), ['implementation', 'spec', 'tests']);
  const running = broker.run(run.id);
  t.after(() => { for (const hold of holds.values()) hold.resolve(green); });
  await until(() => started, value => value.length === 3);
  assert.deepEqual(new Set(started), new Set(['left', 'left-second', 'right']));
  holds.get('left')!.resolve(green);
  holds.get('right')!.resolve(green);
  await until(() => broker.getRun(run.id), value => value.requests.filter(request => request.status === 'GREEN').length === 2);
  assert.equal(broker.getRun(run.id).requests[0].status, 'BLOCKED');
  assert.equal(started.includes('join'), false);
  holds.get('left-second')!.resolve(green);
  await running;
  assert.equal(started.at(-1), 'join');
  assert.equal(broker.getRun(run.id).status, 'GREEN');
  assert.ok(broker.getRun(run.id).requests.every(request => !Object.hasOwn(request, 'predecessorId')));
});

test('non-Human concurrency is bounded while queued independent work progresses as slots become available', async t => {
  const config = defaults();
  config.critics = Array.from({ length: 7 }, (_, index) => {
    const id = `parallel-${index}`;
    config.artifacts[id] = { type: 'markdown', path: 'spec.md' };
    return { ...defaults().critics[0], id, target: id, deps: ['why'] };
  });
  const { open } = await fixture(t, config);
  const holds = new Map(config.critics.map(critic => [critic.id, gate<ReviewResult>()]));
  const started: string[] = [];
  let activeCount = 0, maximum = 0;
  const broker = open(registry(async (request, { signal }) => {
    started.push(request.criticId); activeCount++; maximum = Math.max(maximum, activeCount);
    try { return await Promise.race([holds.get(request.criticId)!.promise, abortableGate(signal)]); } finally { activeCount--; }
  }));
  const run = await broker.submit({ requesterId: 'bounded-builder' });
  const running = broker.run(run.id);
  t.after(() => { for (const hold of holds.values()) hold.resolve(green); });
  await until(() => started.length, value => value === 4);
  assert.equal(broker.getRun(run.id).requests.filter(request => request.status === 'RUNNING').length, 4);
  holds.get(started[0])!.resolve(green);
  await until(() => started.length, value => value === 5);
  for (const hold of holds.values()) hold.resolve(green);
  await running;
  assert.equal(maximum, 4);
  assert.equal(started.length, 7);
  assert.equal(broker.getRun(run.id).status, 'GREEN');
});

test('RED and local ERROR block only dependent branches while independent running work and its successor finish', async t => {
  for (const failure of [{ verdict: 'RED' }, { verdict: 'ERROR', error: new Error('Provider unavailable on this branch.') }, { verdict: 'ERROR', error: undefined }] as const) {
    const verdict = failure.verdict;
    const config = branchConfig();
    config.artifacts.leaf = { type: 'markdown', path: 'spec.md' };
    config.critics.push({ ...config.critics[2], id: 'right-child', target: 'leaf', deps: ['tests'] });
    const { open } = await fixture(t, config);
    const right = gate<ReviewResult>();
    let childRan = false, rightSignal: AbortSignal | undefined;
    const broker = open(registry(async (request, { signal }) => {
      if (request.criticId === 'left') { if (failure.verdict === 'ERROR') throw failure.error; return red; }
      if (request.criticId === 'right') { rightSignal = signal; return Promise.race([right.promise, abortableGate(signal)]); }
      if (request.criticId === 'right-child') { childRan = true; return green; }
      throw new Error('The failed join must not execute.');
    }));
    const run = await broker.submit({ requesterId: 'independent-builder' });
    const running = broker.run(run.id); t.after(() => right.resolve(green));
    await until(() => broker.getRun(run.id), value => value.requests.find(request => request.criticId === 'left')?.status === verdict);
    const partial = broker.getRun(run.id);
    assert.equal(partial.status, 'RUNNING');
    assert.equal(partial.completedAt, undefined);
    assert.equal(rightSignal?.aborted, false);
    assert.equal(partial.requests[0].status, 'BLOCKED');
    right.resolve(green); await running;
    const finished = broker.getRun(run.id);
    assert.equal(finished.status, verdict);
    assert.equal(childRan, true);
    assert.equal(finished.requests[0].status, 'BLOCKED');
    assert.equal(finished.requests[0].completedAt, null);
    assert.match(present(finished.requests[0].blockedReason), new RegExp(`left returned ${verdict}`));
    assert.equal(finished.requests.find(request => request.criticId === 'right-child')?.status, 'GREEN');
  }
});

test('multiple Human copy reviews pause together and each completion can resume its own ready branch before the final join', async t => {
  const config = branchConfig();
  config.critics[1].profile = { kind: 'human' }; config.critics[2].profile = { kind: 'human' };
  config.artifacts.leaf = { type: 'markdown', path: 'spec.md' };
  config.critics.push({ ...defaults().critics[0], id: 'left-child', target: 'leaf', deps: ['spec'] });
  const { open } = await fixture(t, config);
  const notifications: string[] = [], executions: string[] = [];
  const executors = { ...registry(async request => { executions.push(request.criticId); return green; }), notifyHuman: async (request: ReviewRequest) => { notifications.push(request.criticId); } };
  const initial = open(executors);
  const submitted = await initial.submit({ requesterId: 'human-dag' });
  await initial.run(submitted.id);
  const waiting = initial.getRun(submitted.id);
  assert.equal(waiting.owner, null);
  assert.deepEqual(new Set(notifications), new Set(['left', 'right']));
  assert.equal(waiting.requests.filter(request => request.status === 'WAITING_HUMAN').length, 2);
  const left = present(waiting.requests.find(request => request.criticId === 'left'));
  const right = present(waiting.requests.find(request => request.criticId === 'right'));
  const reviewer = open(); await reviewer.claimHuman(left.id, 'alice'); await reviewer.claimHuman(right.id, 'bob');
  await reviewer.completeHuman(left.id, { reviewerId: 'alice', result: green });
  assert.equal(reviewer.getRun(submitted.id).status, 'QUEUED');
  const firstResume = open(executors); await firstResume.run(submitted.id);
  const partial = reviewer.getRun(submitted.id);
  assert.equal(partial.status, 'WAITING_HUMAN'); assert.equal(partial.owner, null);
  assert.deepEqual(executions, ['left-child']);
  assert.equal(partial.requests[0].status, 'BLOCKED');
  await reviewer.completeHuman(right.id, { reviewerId: 'bob', result: green });
  const finalResume = open(executors); await finalResume.run(submitted.id);
  assert.equal(reviewer.getRun(submitted.id).status, 'GREEN');
  assert.deepEqual(executions, ['left-child', 'join']);
  assert.equal(notifications.length, 2);
});

test('a slow Human alarm does not serialize independent execution or another Human notification', async t => {
  const config = branchConfig();
  config.critics[1].profile = { kind: 'human' }; config.critics[2].profile = { kind: 'human' };
  config.artifacts.leaf = { type: 'markdown', path: 'spec.md' };
  config.critics.push({ ...defaults().critics[0], id: 'independent', target: 'leaf', deps: ['why'] });
  const { open } = await fixture(t, config);
  const alarm = gate<void>();
  const broker = open({ ...registry(async () => green), notifyHuman: async (request, { signal }) => { if (request.criticId === 'left') await Promise.race([alarm.promise, abortableGate(signal)]); } });
  const submitted = await broker.submit({ requesterId: 'slow-alarm' });
  const running = broker.run(submitted.id); t.after(() => alarm.resolve());
  await until(() => broker.getRun(submitted.id), run => run.requests.find(request => request.criticId === 'independent')?.status === 'GREEN' && run.requests.find(request => request.criticId === 'right')?.notifiedAt);
  assert.ok(broker.getRun(submitted.id).owner);
  assert.equal(broker.getRun(submitted.id).requests.find(request => request.criticId === 'left')?.notifiedAt, null);
  alarm.resolve(); await running;
  assert.equal(broker.getRun(submitted.id).owner, null);
  assert.equal(broker.getRun(submitted.id).requests.filter(request => request.status === 'WAITING_HUMAN' && request.notifiedAt).length, 2);
});

test('cancel aborts all running sibling tasks and invalidates every unfinished dependency', async t => {
  const { open } = await fixture(t, branchConfig());
  const started: string[] = [], aborted: string[] = [];
  const worker = open(registry(async (request, { signal }) => {
    started.push(request.criticId);
    try { return await abortableGate(signal); } finally { aborted.push(request.criticId); }
  }));
  const run = await worker.submit({ requesterId: 'cancel-dag' });
  const running = worker.run(run.id);
  await until(() => started.length, count => count === 2);
  const requester = open(); requester.cancel(run.id);
  await running;
  const canceled = requester.getRun(run.id);
  assert.deepEqual(new Set(aborted), new Set(['left', 'right']));
  assert.ok(canceled.requests.every(request => request.status === 'ERROR' && request.errorCode === 'REVIEW_CANCELED'));
  assert.equal(canceled.owner, null);
});

test('lock integrity failure invalidates pending Human branches while preserving an already completed verdict', async t => {
  const config = branchConfig(); config.critics[1].profile = { kind: 'human' }; config.critics[2].profile = { kind: 'human' };
  const { repoPath, open } = await fixture(t, config);
  const worker = open({ ...registry(async () => green), notifyHuman: async () => {} });
  const run = await worker.submit({ requesterId: 'lock-dag', mode: 'lock' });
  const running = worker.run(run.id);
  const waiting = await until(() => worker.getRun(run.id), value => value.requests.filter(request => request.notifiedAt).length === 2);
  const reviewer = open(), left = present(waiting.requests.find(request => request.criticId === 'left'));
  await reviewer.claimHuman(left.id, 'alice'); await reviewer.completeHuman(left.id, { reviewerId: 'alice', result: green });
  await fs.writeFile(path.join(repoPath, 'unrelated.txt'), 'Workspace changed during the other Human review.');
  await running;
  const failed = reviewer.getRun(run.id);
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.requests.find(request => request.id === left.id)?.status, 'GREEN');
  assert.ok(failed.requests.filter(request => request.id !== left.id).every(request => request.status === 'ERROR' && request.errorCode === 'WORKSPACE_CHANGED'));
});

test('failed Human alarm leaves an unrelated delivered Human review claimable and completable', async t => {
  const config = branchConfig(); config.critics[1].profile = { kind: 'human' }; config.critics[2].profile = { kind: 'human' };
  const { open } = await fixture(t, config);
  const broker = open({ ...registry(async () => green), notifyHuman: async request => { if (request.criticId === 'left') throw new Error('Left alarm failed.'); } });
  const submitted = await broker.submit({ requesterId: 'alarm-branches' });
  await broker.run(submitted.id);
  const waiting = broker.getRun(submitted.id);
  assert.equal(waiting.status, 'WAITING_HUMAN'); assert.equal(waiting.owner, null);
  assert.equal(waiting.requests.find(request => request.criticId === 'left')?.status, 'ERROR');
  const right = present(waiting.requests.find(request => request.criticId === 'right'));
  assert.equal(right.status, 'WAITING_HUMAN'); assert.ok(right.notifiedAt);
  await broker.claimHuman(right.id, 'reviewer');
  await broker.completeHuman(right.id, { reviewerId: 'reviewer', result: green });
  const result = broker.getRun(submitted.id);
  assert.equal(result.status, 'ERROR');
  assert.equal(result.requests.find(request => request.id === right.id)?.status, 'GREEN');
  assert.equal(result.requests[0].status, 'BLOCKED');
});

test('a dead copy worker with a notified Human and an executing sibling invalidates all unfinished work', async t => {
  const config = branchConfig(); config.critics[2].profile = { kind: 'human' };
  const { repoPath, stateDir, open } = await fixture(t, config);
  const moduleUrl = new URL('../src/broker/index.js', import.meta.url).href;
  const script = `import {createBroker} from ${JSON.stringify(moduleUrl)};
    const broker=createBroker({repoPath:${JSON.stringify(repoPath)},stateDir:${JSON.stringify(stateDir)},executors:{
      canExecute:()=>({ok:true}),notifyHuman:async()=>{process.stdout.write('NOTIFIED\\n');},
      execute:async(_request,{signal})=>{process.stdout.write('EXECUTING\\n');await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}});
    const run=await broker.submit({mode:'copy',requesterId:'copy-crash'});process.stdout.write(run.id+'\\n');await broker.run(run.id);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
  t.after(() => { child.kill('SIGKILL'); });
  await until(() => output, value => value.includes('NOTIFIED') && value.includes('EXECUTING')).catch(error => { throw new Error(`${error.message}\n${errors}`); });
  const runId = output.trim().split('\n')[0], observer = open();
  await until(() => observer.getRun(runId), run => run.requests.some(request => request.notifiedAt) && run.requests.some(request => request.status === 'RUNNING'));
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  const failed = observer.getRun(runId);
  assert.equal(failed.status, 'ERROR'); assert.equal(failed.owner, null);
  assert.ok(failed.requests.every(request => request.status === 'ERROR' && request.errorCode === 'WORKER_EXITED'));
});

test('pending historical chains resume through explicit predecessor links and old Human tools without inferring target Artifacts', async t => {
  const config = defaults(); config.critics[0].profile = { kind: 'human' };
  const { repoPath, stateDir, open } = await fixture(t, config);
  const executions: string[] = [];
  const executors = { ...registry(async request => { executions.push(request.criticId); return green; }), notifyHuman: async () => {} };
  const setup = open(executors);
  const run = await setup.submit({ requesterId: 'historical' }); await setup.close();
  const legacyConfig = { ...config, critics: config.critics.map((critic, index) => ({
    id: critic.id, title: critic.title, dependsOn: index ? config.critics[index - 1].id : null,
    artifacts: [critic.target, ...critic.deps], profile: critic.profile, payload: critic.payload,
  })) };
  await fs.writeFile(path.join(repoPath, 'ccdd.config.json'), JSON.stringify(legacyConfig));
  const captured = await prepareWorkspace({ repoPath, stateDir, mode: 'copy' });
  const descriptor = captured.descriptor;
  const db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
  try {
    const stored = JSON.parse(String(present(db.prepare('SELECT data FROM runs WHERE id=?').get(run.id)).data)) as Record<string, unknown>;
    delete stored.graph; stored.scope = { kind: 'chain' }; stored.workspace = descriptor; stored.snapshotHash = descriptor.hash;
    db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(stored), run.id);
    for (const [index, request] of run.requests.entries()) {
      const historical: Record<string, unknown> = { ...request, workspace: descriptor, snapshotHash: descriptor.hash, worktreePath: descriptor.path,
        predecessorId: index ? run.requests[index - 1].id : null, dependsOn: legacyConfig.critics[index].dependsOn };
      delete historical.target; delete historical.deps;
      db.prepare('UPDATE requests SET data=? WHERE id=?').run(JSON.stringify(historical), request.id);
    }
  } finally { db.close(); await captured.close(); }
  const worker = open(executors); await worker.run(run.id);
  const waiting = worker.getRun(run.id);
  assert.deepEqual(waiting.scope, { kind: 'chain' }); assert.equal(waiting.graph, undefined);
  assert.equal(waiting.status, 'WAITING_HUMAN');
  await worker.claimHuman(waiting.requests[0].id, 'legacy-reviewer');
  const read = await worker.executeHumanTool(waiting.requests[0].id, { reviewerId: 'legacy-reviewer', toolName: 'read_spec' });
  assert.ok('content' in read); assert.equal(read.content, 'Current workspace specification.');
  await worker.completeHuman(waiting.requests[0].id, { reviewerId: 'legacy-reviewer', result: green });
  await worker.run(run.id);
  const finished = worker.getRun(run.id);
  assert.equal(finished.status, 'GREEN');
  assert.deepEqual(executions, ['tests-spec', 'implementation-tests']);
  assert.ok(finished.requests.every(request => !Object.hasOwn(request, 'target') && !Object.hasOwn(request, 'deps')));
  assert.equal(finished.graph, undefined);
});

test('a fatal task rejection survives another task winning the scheduler race and cancels pending siblings', async t => {
  const config = branchConfig();
  config.artifacts.third = { type: 'markdown', path: 'spec.md' };
  config.critics.push({ ...config.critics[2], id: 'third', target: 'third', deps: ['why'] });
  const { open } = await fixture(t, config);
  const first = gate<ReviewResult>();
  let rejectSecond!: (reason: Error) => void;
  const second = new Promise<ReviewResult>((_resolve, reject) => { rejectSecond = reject; });
  const started: string[] = [], aborted: string[] = [];
  const broker = open(registry(async (request, { signal }) => {
    started.push(request.criticId);
    if (request.criticId === 'left') return Promise.race([first.promise, abortableGate(signal)]);
    if (request.criticId === 'right') return Promise.race([second, abortableGate(signal)]);
    try { return await abortableGate(signal); } finally { aborted.push(request.criticId); }
  }));
  const run = await broker.submit({ requesterId: 'fatal-race' });
  let triggered = false;
  const off = broker.onChange(() => {
    if (!triggered && broker.getRun(run.id).requests.find(request => request.criticId === 'left')?.status === 'GREEN') {
      triggered = true;
      rejectSecond(Object.assign(new Error('Synthetic workspace monitor failure at a task boundary.'), { code: 'WORKSPACE_CHANGED' }));
    }
  });
  t.after(off);
  const running = broker.run(run.id);
  await until(() => started.length, count => count === 3);
  first.resolve(green);
  await until(() => broker.getRun(run.id).status, status => status === 'ERROR', 2000);
  await running;
  const failed = broker.getRun(run.id);
  assert.equal(triggered, true);
  assert.deepEqual(aborted, ['third']);
  assert.equal(failed.requests.find(request => request.criticId === 'left')?.status, 'GREEN');
  assert.ok(failed.requests.filter(request => request.criticId !== 'left').every(request => request.status === 'ERROR' && request.errorCode === 'WORKSPACE_CHANGED'));
});
