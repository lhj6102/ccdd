import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createBroker, readStateContext } from '../src/broker/index.mjs';
import { prepareReviewRequests } from '../src/requester/index.mjs';
import { fingerprintWorkspace, removeOwnedWorkspaceTree, prepareWorkspace, reopenWorkspace } from '../src/workspaces/index.mjs';
import { createExecutorRegistry } from '../src/executors/index.mjs';

const green = { verdict: 'GREEN', summary: 'The workspace meets its criterion.', evidence: ['Checked the submitted artifact.'] };
const red = { verdict: 'RED', summary: 'The criterion is not met.', evidence: ['The expected value differs.'] };
const defaults = () => ({
  artifacts: { why: { type: 'markdown', path: 'why.md' }, spec: { type: 'markdown', path: 'spec.md' }, tests: { type: 'code', path: 'tests' }, implementation: { type: 'code', path: 'implementation' } },
  artifactTypes: { markdown: { viewer: 'text' }, code: { viewer: 'files' } },
  critics: [
    { id: 'spec-why', title: 'Spec / Why', dependsOn: null, artifacts: ['why', 'spec'], profile: { kind: 'agent', provider: 'test', model: 'test', reasoning: 'medium' }, payload: { instruction: 'Compare {why} and {spec}.' } },
    { id: 'tests-spec', title: 'Tests / Spec', dependsOn: 'spec-why', artifacts: ['spec', 'tests'], profile: { kind: 'agent', provider: 'test', model: 'test', reasoning: 'medium' }, payload: { instruction: 'Compare {spec} and {tests}.' } },
    { id: 'implementation-tests', title: 'Runtime', dependsOn: 'tests-spec', artifacts: ['tests', 'implementation'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/example.test.mjs'] }, payload: { instruction: 'Execute tests.' } },
  ],
});
const registry = execute => ({ canExecute: () => ({ ok: true }), execute });

async function fixture(t, config = defaults()) {
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
  const brokers = [];
  const open = (executors, options = {}) => { const broker = createBroker({ repoPath, stateDir, executors, ...options }); brokers.push(broker); return broker; };
  t.after(async () => { for (const broker of brokers) await broker.close(); await removeOwnedWorkspaceTree(dir); });
  return { dir, repoPath, stateDir, setConfig, open };
}

async function until(read, check, timeout = 10_000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) { const value = read(); if (check(value)) return value; await delay(10); }
  throw new Error(`Timed out waiting for broker state: ${JSON.stringify(read())}`);
}

function abortableGate(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('submission persists a handle without executing; a separate broker runs the copied current workspace sequentially', async t => {
  const { repoPath, open } = await fixture(t);
  await fs.writeFile(path.join(repoPath, 'untracked.txt'), 'New input without any Git repository or commit.');
  const calls = [];
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
  assert.deepEqual(record.scope, { kind: 'chain' });
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
  assert.equal(completed.requests[1].predecessorId, completed.requests[0].id);
  assert.equal(completed.requests[0].snapshotHash, completed.workspace.hash);
  assert.equal(completed.owner, null);
  assert.ok(completed.events.some(event => event.type === 'workspace.ready'));
  assert.equal(reader.listRuns()[0].id, completed.id);
});

test('same content shares one copied workspace across concurrent reviews while requests and output directories remain independent', async t => {
  const { open } = await fixture(t);
  const entered = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
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
  const actual = createExecutorRegistry({ codexPath: '/missing-codex' });
  const checks = [];
  const broker = open({ canExecute: request => { checks.push(request.criticId); return actual.canExecute(request); }, execute: (request, context) => actual.execute(request, context) });
  await assert.rejects(broker.submit({ requesterId: 'builder' }), /Provider is not registered/);
  assert.deepEqual(broker.listRuns(), []);
  checks.length = 0;
  const initial = await broker.submit({ requesterId: 'builder', criticId: 'implementation-tests' });
  await broker.run(initial.id);
  const completed = broker.getRun(initial.id);
  assert.equal(completed.status, 'GREEN', JSON.stringify(completed));
  assert.deepEqual(completed.scope, { kind: 'critic', criticId: 'implementation-tests' });
  assert.equal(completed.requests.length, 1);
  assert.equal(completed.requests[0].dependsOn, 'tests-spec');
  assert.equal(completed.requests[0].predecessorId, null);
  assert.equal(completed.requests[0].result.exitCode, 0);
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
  const checks = [];
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
  const calls = [];
  const broker = open(registry(async request => { calls.push(request.criticId); return red; }));
  const record = await broker.submit({ requesterId: 'builder' });
  await broker.run(record.id);
  const completed = broker.getRun(record.id);
  assert.equal(completed.status, 'RED');
  assert.deepEqual(calls, ['spec-why']);
  assert.deepEqual(completed.requests.map(request => request.status), ['RED', 'BLOCKED', 'BLOCKED']);
  assert.match(completed.requests[2].blockedReason, /spec-why returned RED/);
  const failed = open(registry(async () => { throw new Error('Provider unavailable.'); }));
  const next = await failed.submit({ requesterId: 'builder' });
  await failed.run(next.id);
  assert.equal(failed.getRun(next.id).status, 'ERROR');
  assert.equal(failed.getRun(next.id).requests[0].result, null);
  assert.match(failed.getRun(next.id).requests[0].error, /Provider unavailable/);
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
  let release;
  const gate = new Promise(resolve => { release = resolve; });
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
  const notifications = []; const executed = [];
  const executors = { ...registry(async request => { executed.push(request.criticId); return green; }), notifyHuman: async request => notifications.push(request.id) };
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
  alice.claimHuman(requestId, 'alice');
  assert.throws(() => bob.claimHuman(requestId, 'bob'), /another reviewer/);
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
  assert.equal(waiting.owner.pid, process.pid);
  const reviewer = open(); reviewer.claimHuman(waiting.requests[0].id, 'alice');
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
  const reviewer = open(); reviewer.claimHuman(waiting.requests[0].id, 'alice');
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
  assert.match(failed.requests[0].error, /Alarm delivery failed/);
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
  assert.match(client.getRun(second.id).requests[0].error, /Cannot launch/);
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
  const moduleUrl = new URL('../src/broker/index.mjs', import.meta.url).href;
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
  assert.deepEqual(failed.requests.map(request => request.status), ['ERROR', 'BLOCKED', 'BLOCKED']);
});

test('completed legacy scope-less records are readable without replay and nested state is rejected without creating it', async t => {
  const { repoPath, stateDir, open } = await fixture(t);
  const broker = open(registry(async () => green));
  const record = await broker.submit({ requesterId: 'builder' }); await broker.run(record.id); await broker.close();
  const db = new DatabaseSync(path.join(stateDir, 'broker.sqlite'));
  const stored = JSON.parse(db.prepare('SELECT data FROM runs WHERE id = ?').get(record.id).data);
  delete stored.scope; delete stored.workspace;
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
  let record;
  let paused = false;
  let entered;
  const atValidation = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const executors = { ...registry(async () => green), notifyHuman: async () => {} };
  const worker = open(executors, { workspaceAdapter: {
    prepareWorkspace,
    async reopenWorkspace(...args) {
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
  reviewer.claimHuman(record.requests[0].id, 'alice');
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
  let record;
  let held = false;
  let entered;
  const atCleanup = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const executors = { ...registry(async () => green), notifyHuman: async () => {} };
  const worker = open(executors, { workspaceAdapter: {
    prepareWorkspace,
    async reopenWorkspace(...args) {
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
  reviewer.claimHuman(record.requests[0].id, 'alice');
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
  reviewer.claimHuman(record.requests[0].id, 'alice');
  await reviewer.completeHuman(record.requests[0].id, { reviewerId: 'alice', result: green });
  const worker = open(executors); await worker.run(record.id);
  assert.equal(reviewer.getRun(record.id).status, 'GREEN');
  await assert.rejects(worker.submit({ requesterId: 'missing-source' }), { code: 'ENOENT' });
});
