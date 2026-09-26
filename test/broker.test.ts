import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, type BrokerExecutors } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { artifactFixture, runtimeCritic, fixtureViews } from './helpers/artifacts.js';
import { runUntilSettled } from './helpers/run.js';
import { inspectProject, projectHistory, projectRun } from '../src/project/index.js';
import { artifactStream } from './pi-fixture.js';
import { agentProfile } from './helpers/artifacts.js';

import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { StreamFn } from '../src/executors/pi.js';
import { DatabaseSync } from 'node:sqlite';

const controlledResult = { verdict: 'GREEN' as const };
async function fixture(t: TestContext, human = false, executors?: BrokerExecutors) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [human ? { id: 'check', title: 'Human review', profile: { kind: 'human' }, payload: { instruction: 'Read {a}.' } } : runtimeCritic()] });
  const broker = createBroker({ detail: 'full', ...data, executors: executors ?? createExecutorRegistry({ alarmMethods: [async () => {}] }) });
  data.cleanup(() => broker.close());
  return { ...data, broker, submit: () => broker.submitProject({ selection: { kind: 'all' } }) };
}
async function waitFor(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); } throw new Error('Condition did not become ready.'); }

test('submission persists executable tickets without evaluating; actual Runtime results survive reopening', async t => {
  const data = await fixture(t), submitted = await data.submit();
  assert.equal(submitted.requests[0].status, 'QUEUED'); assert.equal(submitted.requests[0].result, null);
  assert.equal((await data.broker.run(submitted.id))!.status, 'GREEN');
  await data.broker.close(); const client = createBroker({ ...data, detail: 'full' }); data.cleanup(() => client.close());
  assert.equal(client.getRun(submitted.id)!.requests[0].result!.exitCode, 0);
});

test('cyclic Critics start together without awaiting each other and completion still needs both results', async t => {
  const started: string[] = []; let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const data = await fixture(t, false, { canExecute: () => ({ ok: true }), async execute(request) { started.push(request.criticId); await gate; return controlledResult; } });
  await data.edit('a', m => { m.critics![0].payload.instruction = 'Compare {b}.'; });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Compare {a}.')] });
  const run = await data.submit(), running = data.broker.run(run.id); t.after(() => release());
  await waitFor(() => started.length === 2); assert.ok(data.broker.getRun(run.id)!.requests.every(r => r.status === 'RUNNING'));
  release(); assert.equal((await running)!.status, 'GREEN');
});

test('executor concurrency remains bounded while independent slots progress', async t => {
  let active = 0, maximum = 0;
  const data = await fixture(t, false, { canExecute: () => ({ ok: true }), async execute() { maximum = Math.max(maximum, ++active); await delay(40); active--; return controlledResult; } });
  for (let i = 0; i < 8; i++) await data.write(`extra-${i}`, { name: `extra-${i}`, critics: [runtimeCritic()] });
  const run = await data.submit(); assert.equal((await data.broker.run(run.id))!.status, 'GREEN'); assert.equal(maximum, 4);
});

test('RED and operational ERROR retain independent results and never block other ready Critics', async t => {
  const data = await fixture(t, false, { canExecute: () => ({ ok: true }), async execute(request) {
    if (request.target === 'a') return { ...controlledResult, verdict: 'RED' };
    if (request.target === 'c') throw new Error('Controlled operational failure');
    return controlledResult;
  } });
  await data.write('b', { name: 'b', critics: [runtimeCritic('check', 'Depends on {a}.')] });
  await data.write('c', { name: 'c', critics: [runtimeCritic()] });
  const run = await data.submit(), completed = (await data.broker.run(run.id))!;
  assert.equal(completed.status, 'ERROR'); assert.deepEqual(completed.requests.map(r => r.status), ['RED', 'GREEN', 'ERROR']);
});

test('Human tools require the active claimant and preserve review state until explicit completion', async t => {
  const data = await fixture(t, true), run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const request = data.broker.getRun(run.id)!.requests[0];
  await assert.rejects(data.broker.executeHumanTool(request.id, { reviewerId: 'reader', toolName: 'read_a' }), /claimed/);
  await data.broker.claimHuman(request.id, 'reader');
  await assert.rejects(data.broker.claimHuman(request.id, 'other'), /another reviewer/);
  const result = await data.broker.executeHumanTool(request.id, { reviewerId: 'reader', toolName: 'read_a', arguments: { lineCount: 1 } });
  assert.equal(result.observation?.kind, 'content'); assert.equal(data.broker.getRequest(request.id)!.status, 'WAITING_HUMAN');
  await assert.rejects(data.broker.completeHuman(request.id, { reviewerId: 'other', result: controlledResult }), /claimed/);
  await data.broker.completeHuman(request.id, { reviewerId: 'reader', result: { ...controlledResult } });
  await waitFor(() => data.broker.getRun(run.id)!.status === 'GREEN');
});

test('separate clients claim and complete a Human cycle while the owning worker continues', async t => {
  const data = await fixture(t, true);
  await data.edit('a', m => { m.mounts = { peer: 'b' }; });
  await data.write('b', { name: 'b', views: fixtureViews(), mounts: { peer: 'a' }, critics: [{ id: 'human', title: 'Second Human', profile: { kind: 'human' }, payload: { instruction: 'Read {b}.' } }] });
  const run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const client = createBroker({ ...data, detail: 'full' }); data.cleanup(() => client.close());
  const requests = client.getRun(run.id)!.requests;
  for (const request of requests) await client.claimHuman(request.id, 'fixture-reader');
  await client.completeHuman(requests[0].id, { reviewerId: 'fixture-reader', result: controlledResult });
  assert.equal(client.getRun(run.id)!.status, 'WAITING_HUMAN');
  await client.completeHuman(requests[1].id, { reviewerId: 'fixture-reader', result: controlledResult });
  await waitFor(() => client.getRun(run.id)!.status === 'GREEN' && !client.getRun(run.id)!.owner);
});

for (const mutation of ['edit', 'restore', 'create-delete'] as const) test(`Human waiting detects ${mutation} anywhere in the workspace`, async t => {
  const data = await fixture(t, true), run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const filename = join(data.repoPath, 'outside.txt');
  if (mutation === 'create-delete') { await writeFile(filename, 'x'); await (await import('node:fs/promises')).unlink(filename); }
  else { const file = join(data.repoPath, 'a/content.txt'), before = await readFile(file); await writeFile(file, 'changed'); if (mutation === 'restore') await writeFile(file, before); }
  await waitFor(() => data.broker.getRun(run.id)!.status === 'ERROR');
  assert.equal(data.broker.getRun(run.id)!.requests[0].errorCode, 'WORKSPACE_CHANGED');
  assert.equal(data.broker.getRun(run.id)!.requests[0].result, null);
});

test('changed input between submission and worker acquisition rejects execution', async t => {
  let executions = 0;
  const data = await fixture(t, false, { canExecute: () => ({ ok: true }), async execute() { executions++; return controlledResult; } });
  const run = await data.submit(); await writeFile(join(data.repoPath, 'a/content.txt'), 'changed');
  assert.equal((await data.broker.run(run.id))!.status, 'ERROR'); assert.equal(executions, 0);
});

test('Human scripts that mutate input cannot return a successful tool result or semantic verdict', async t => {
  const data = await fixture(t, true);
  await writeFile(join(data.repoPath, 'a/view.mjs'), "import {writeFile} from 'node:fs/promises';let text='';for await(const chunk of process.stdin)text+=chunk;const {context}=JSON.parse(text);await writeFile(context.artifactPath+'/content.txt','changed');process.stdout.write(JSON.stringify({content:[{type:'json',data:'changed'}],observation:{kind:'content'}}));");
  const run = await data.submit(); await runUntilSettled(data.broker, run.id); const request = data.broker.getRun(run.id)!.requests[0];
  await data.broker.claimHuman(request.id, 'reader'); await assert.rejects(data.broker.executeHumanTool(request.id, { reviewerId: 'reader', toolName: 'read_a' }));
  assert.equal(data.broker.getRun(run.id)!.status, 'ERROR'); assert.equal(data.broker.getRequest(request.id)!.result, null);
});

test('Human completion rechecks authority after acquisition and rejects conflicting completed submissions', async t => {
  const data = await fixture(t, true), run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const request = data.broker.getRun(run.id)!.requests[0]; await data.broker.claimHuman(request.id, 'reader');
  const results = await Promise.allSettled([data.broker.completeHuman(request.id, { reviewerId: 'reader', result: controlledResult }), data.broker.completeHuman(request.id, { reviewerId: 'reader', result: { ...controlledResult, verdict: 'RED' } })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['GREEN', 'RED'].includes(data.broker.getRequest(request.id)!.status));
});

test('a second broker cannot take live ownership and closing a reader leaves the worker alive', async t => {
  const data = await fixture(t, true), run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const client = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry({ alarmMethods: [async () => {}] }) });
  await assert.rejects(client.run(run.id), { code: 'RUN_ALREADY_OWNED' }); await client.close();
  assert.ok(data.broker.getRun(run.id)!.owner); assert.equal(data.broker.getRun(run.id)!.status, 'WAITING_HUMAN');
});

test('cancel from another client interrupts active processes and leaves unrelated queued work intact', async t => {
  const data = await fixture(t, true), first = await data.submit(), second = await data.submit();
  await runUntilSettled(data.broker, first.id);
  const client = createBroker({ ...data, detail: 'full' }); data.cleanup(() => client.close()); client.cancel(first.id);
  await waitFor(() => !client.getRun(first.id)!.owner);
  assert.equal(client.getRun(first.id)!.status, 'ERROR'); assert.equal(client.getRun(second.id)!.status, 'QUEUED');
});

test('closing an owning broker stops Human monitoring and dead worker reconciliation never fabricates PASS', async t => {
  const data = await fixture(t, true), run = await data.submit(); await runUntilSettled(data.broker, run.id); await data.broker.close();
  const client = createBroker({ ...data, detail: 'full' }); data.cleanup(() => client.close());
  assert.equal(client.getRun(run.id)!.requests[0].errorCode, 'WORKER_STOPPED');
  const next = await fixture(t, true), pending = await next.submit();
  const db = new DatabaseSync(join(next.stateDir, 'broker.sqlite'));
  db.prepare('INSERT INTO run_owners(run_id,pid,process_identity,token,claimed_at) VALUES (?,?,?,?,?)').run(pending.id, 2147483647, null, 'dead-fixture', new Date().toISOString()); db.close();
  assert.equal(next.broker.getRun(pending.id)!.status, 'ERROR'); assert.equal(next.broker.getRun(pending.id)!.requests[0].errorCode, 'WORKER_EXITED');
});

test('failed Human alarms remain operational failures while independent Human work completes', async t => {
  const data = await fixture(t, true, createExecutorRegistry({ alarmMethods: [async request => { if (request.target === 'a') throw new Error('Controlled alarm failure'); }] }));
  await data.write('b', { name: 'b', views: fixtureViews(), critics: [{ id: 'review', title: 'Human', profile: { kind: 'human' }, payload: { instruction: 'Read {b}.' } }] });
  const run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const requests = data.broker.getRun(run.id)!.requests; assert.equal(requests[0].status, 'ERROR'); assert.equal(requests[0].notifiedAt, null);
  await data.broker.claimHuman(requests[1].id, 'reader'); await data.broker.completeHuman(requests[1].id, { reviewerId: 'reader', result: controlledResult });
  await waitFor(() => data.broker.getRun(run.id)!.status === 'ERROR'); assert.equal(data.broker.getRequest(requests[1].id)!.status, 'GREEN');
});

test('workspace preflight rejects embedded credentials before any tickets or input acquisition', async t => {
  const data = await fixture(t, false, { validateWorkspace() { throw new Error('Controlled credential boundary'); }, canExecute: () => ({ ok: true }), execute: async () => controlledResult });
  const before = await readdir(data.repoPath); await assert.rejects(data.submit(), /credential boundary/); assert.deepEqual(data.broker.listRuns(), []); assert.deepEqual(await readdir(data.repoPath), before);
});


test('run telemetry survives readonly reopening but never changes identities, evidence or reuse', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry({ streamFn: artifactStream() }) }); data.cleanup(() => broker.close());
  const before = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  const submitted = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(submitted.id);
  const run = projectRun(data.stateDir, submitted.id)!;
  assert.equal(run.status, 'GREEN');
  const timing = run.events.find(event => event.type === 'artifact.tool.completed')!.data as Record<string, unknown>;
  assert.equal(timing.outcome, 'success'); assert.equal(timing.name, 'read_a'); assert.ok(Number(timing.durationMs) >= 0);
  assert.equal(run.events.filter(event => event.type === 'executor.usage').length, 2);
  const actual = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  assert.deepEqual(actual.inputs, before.inputs); assert.deepEqual(actual.artifactHashes, before.artifactHashes);
  assert.doesNotMatch(JSON.stringify(projectHistory(data.stateDir, { detail: 'full' })), /durationMs|startedAt|usage|cost/);
  assert.doesNotMatch(JSON.stringify(run.requests[0].result!.toolCalls), /durationMs|startedAt|usage/);
  const reused = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(reused.requests.length, 0); assert.equal(reused.status, 'GREEN');
  assert.equal(projectRun(data.stateDir, reused.id)!.events.some(event => event.type === 'executor.usage'), false);
  await broker.close();
  assert.deepEqual(projectRun(data.stateDir, run.id)!.events, run.events);
});

test('Broker telemetry allowlists counters and retains diagnostics on failed attempts', async t => {
  const data = await fixture(t, false, { canExecute: () => ({ ok: true }), async execute(_request, { onEvent }) {
    await onEvent?.({ type: 'artifact.tool.completed', name: 'read_a', artifactId: 'a', operation: 'read', startedAt: '2026-09-24T12:00:00.000Z', durationMs: 12.25, outcome: 'error', contentBytes: 7, contentBytesByType: { text: 7, json: 0, image: 0, launch: 0, secret: 'PRIVATE' }, stderr: 'SECRET_DIAGNOSTIC' });
    await onEvent?.({ type: 'executor.usage', provider: 'fixture', model: 'fixture', usage: { input: 10, output: 2, totalTokens: 12, cacheRead: -1, cacheWrite: '3', reasoning: Infinity, cost: 1.25, response: 'SECRET_DIAGNOSTIC' } });
    await onEvent?.({ type: 'executor.usage', usage: { input: NaN } });
    throw new Error('Controlled later execution failure');
  } });
  const submitted = await data.submit(); await data.broker.run(submitted.id);
  const run = projectRun(data.stateDir, submitted.id)!;
  assert.equal(run.status, 'ERROR'); assert.equal(run.requests[0].result, null);
  const usage = run.events.filter(event => event.type === 'executor.usage');
  assert.equal(usage.length, 1); assert.deepEqual((usage[0].data as { usage: unknown }).usage, { input: 10, output: 2, totalTokens: 12 });
  assert.deepEqual(run.events.find(event => event.type === 'artifact.tool.completed')!.data, { name: 'read_a', artifactId: 'a', startedAt: '2026-09-24T12:00:00.000Z', durationMs: 12.25, outcome: 'error', operation: 'read', contentBytes: 7, contentBytesByType: { text: 7, json: 0, image: 0, launch: 0 } });
  assert.doesNotMatch(JSON.stringify(run), /SECRET_DIAGNOSTIC|cost/);
});


for (const fail of [false, true]) test(`Human ${fail ? 'failed' : 'successful'} tool diagnostics retain timing only after authority and input checks`, async t => {
  const data = await fixture(t, true);
  if (fail) await writeFile(join(data.repoPath, 'a/view.mjs'), "process.stderr.write('PRIVATE_TOOL_FAILURE');process.exit(2);");
  const run = await data.submit(); await runUntilSettled(data.broker, run.id);
  const request = data.broker.getRun(run.id)!.requests[0]; await data.broker.claimHuman(request.id, 'reader');
  const call = data.broker.executeHumanTool(request.id, { reviewerId: 'reader', toolName: 'read_a' });
  if (fail) await assert.rejects(call, /nonzero/); else await call;
  const event = projectRun(data.stateDir, run.id)!.events.find(event => event.type === 'human.tool.executed')!;
  const timing = event.data as { outcome: string; durationMs: number; startedAt: string };
  assert.equal(timing.outcome, fail ? 'error' : 'success'); assert.ok(timing.durationMs >= 0); assert.ok(Number.isFinite(Date.parse(timing.startedAt)));
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_TOOL_FAILURE/);
  assert.equal(data.broker.getRequest(request.id)!.status, 'WAITING_HUMAN');
});

for (const nonzero of [false, true]) test(`script ${nonzero ? 'nonzero failures withhold stdout and stderr' : 'authored errors reach Pi as tool errors and survive stored evaluations'}`, async t => {
  const data = await artifactFixture(t), views = fixtureViews();
  views.agentTools!.reject = { ...views.agentTools!.read, script: { command: 'node', args: ['reject.mjs'] } };
  await data.write('a', { name: 'a', views, critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a} and test rejection.' } }] }, {
    'reject.mjs': `process.stderr.write('PRIVATE_STDERR_CREDENTIAL');console.log(JSON.stringify({isError:true,content:[{type:'text',text:'Unknown skill 16145'}]}));${nonzero ? 'process.exit(3);' : ''}`,
  });
  let faux: ReturnType<typeof fauxProvider> | undefined, received = false;
  const streamFn: StreamFn = (model, context, options) => {
    faux ??= fauxProvider({ provider: model.provider, api: model.api });
    const errors = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'reject_a');
    if (errors.length) {
      received = true;
      assert.equal(errors[0].role === 'toolResult' && errors[0].isError, true);
      const text = JSON.stringify(errors[0]);
      assert.doesNotMatch(text, /PRIVATE_STDERR/);
      if (nonzero) { assert.doesNotMatch(text, /Unknown skill/); assert.match(text, /Custom error text is withheld/); }
      else assert.match(text, /Unknown skill 16145/);
    }
    faux.appendResponses([fauxAssistantMessage(errors.length ? JSON.stringify(controlledResult) : [fauxToolCall('reject_a', {}), fauxToolCall('read_a', {})], errors.length ? {} : { stopReason: 'toolUse' })]);
    return faux.provider.streamSimple(model, context, options);
  };
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry({ streamFn }) }); data.cleanup(() => broker.close());
  const submitted = await broker.submitProject({ selection: { kind: 'all' } }), run = (await broker.run(submitted.id))!;
  assert.equal(received, true); assert.equal(run.status, 'GREEN');
  const calls = run.requests[0].result!.toolCalls!;
  const rejected = calls.find(call => call.name === 'reject_a');
  if (nonzero) assert.equal(rejected, undefined);
  else { assert.equal(rejected?.isError, true); assert.equal(rejected?.observation?.kind, undefined); }
  assert.equal(calls.find(call => call.name === 'read_a')?.observation?.kind, 'content');
  const events = projectRun(data.stateDir, run.id)!.events.filter(event => event.type === 'artifact.tool.called');
  assert.equal(events.some(event => (event.data as { isError?: boolean }).isError), !nonzero);
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_STDERR|Unknown skill/);
  await broker.close(); const reopened = createBroker({ ...data, detail: 'full' }); data.cleanup(() => reopened.close());
  assert.deepEqual(reopened.getRun(run.id)!.requests[0].result!.toolCalls, calls);
});

for (const repaired of [true, false]) test(`final-format repair audit survives reopening and ${repaired ? 'preserves normal reuse' : 'cannot create reusable evidence on failure'}`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  let faux: ReturnType<typeof fauxProvider> | undefined, calls = 0;
  const streamFn: StreamFn = (model, context, options) => {
    calls++;
    if (!faux) {
      faux = fauxProvider({ provider: model.provider, api: model.api });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read_a', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('{"verdict":"PRIVATE_VALUE","PRIVATE_KEY":"PRIVATE_TEXT"}'),
        fauxAssistantMessage(repaired ? JSON.stringify(controlledResult) : '{"verdict":"PRIVATE_VALUE"}'),
      ]);
    }
    return faux.provider.streamSimple(model, context, options);
  };
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry({ streamFn }) }); data.cleanup(() => broker.close());
  const before = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  const submitted = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(submitted.id);
  const run = projectRun(data.stateDir, submitted.id)!;
  assert.equal(run.status, repaired ? 'GREEN' : 'ERROR'); assert.equal(calls, 3);
  assert.deepEqual(run.events.filter(event => event.type === 'executor.final.repair').map(event => event.data), [{ outcome: 'started' }, { outcome: repaired ? 'succeeded' : 'failed' }]);
  assert.deepEqual(run.events.filter(event => event.type === 'executor.final.invalid').map(event => event.data), [
    { attempt: 'initial', category: 'schema_mismatch' }, ...(repaired ? [] : [{ attempt: 'repair', category: 'schema_mismatch' }]),
  ]);
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_/);
  const after = (await inspectProject({ ...data, detail: 'full' })).snapshot;
  assert.deepEqual(after.inputs, before.inputs); assert.deepEqual(after.artifactHashes, before.artifactHashes);
  if (repaired) {
    assert.equal(run.requests[0].result!.toolCalls!.length, 1);
    const reused = await broker.submitProject({ selection: { kind: 'all' } });
    assert.equal(reused.requests.length, 0); assert.equal(reused.status, 'GREEN');
    assert.equal(projectRun(data.stateDir, reused.id)!.events.some(event => event.type.startsWith('executor.final.')), false);
  } else {
    assert.equal(run.requests[0].result, null);
    assert.deepEqual(projectHistory(data.stateDir, { detail: 'full' }), []);
  }
  await broker.close(); assert.deepEqual(projectRun(data.stateDir, submitted.id)!.events, run.events);
});

test('Broker final-result diagnostics allowlist only bounded categories, attempts and outcomes', async t => {
  const data = await fixture(t, false, { canExecute: () => ({ ok: true }), async execute(_request, { onEvent }) {
    await onEvent?.({ type: 'executor.final.invalid', category: 'schema_mismatch', attempt: 'initial', message: 'PRIVATE_MESSAGE', issues: [{ schemaPath: '/PRIVATE_KEY', keyword: 'PRIVATE_KEY' }], name: 'PRIVATE_NAME', response: 'PRIVATE_TEXT' });
    await onEvent?.({ type: 'executor.final.repair', outcome: 'started', message: 'PRIVATE_MESSAGE', tools: ['PRIVATE_TOOL'], observation: { kind: 'content', artifactId: 'a' } });
    await onEvent?.({ type: 'executor.final.invalid', category: 'PRIVATE_CATEGORY', attempt: 'initial' });
    await onEvent?.({ type: 'executor.final.invalid', category: 'empty', attempt: 'PRIVATE_ATTEMPT' });
    await onEvent?.({ type: 'executor.final.repair', outcome: 'PRIVATE_OUTCOME' });
    const coercible = (safe: string) => ({ toString() { throw new Error(`PRIVATE_COERCION_${safe}`); } });
    await onEvent?.({ type: 'executor.final.invalid', category: coercible('empty'), attempt: 'initial' });
    await onEvent?.({ type: 'executor.final.invalid', category: 'empty', attempt: coercible('initial') });
    await onEvent?.({ type: 'executor.final.repair', outcome: coercible('started') });
    throw new Error('Controlled failure');
  } });
  const submitted = await data.submit(); await data.broker.run(submitted.id);
  const events = projectRun(data.stateDir, submitted.id)!.events.filter(event => event.type.startsWith('executor.final.'));
  assert.deepEqual(events.map(event => event.data), [{ attempt: 'initial', category: 'schema_mismatch' }, { outcome: 'started' }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('the persisted result envelope size is checked before accepting a final response or repair', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, passSchema: { type: 'object', properties: { details: { type: 'string' } } }, payload: { instruction: 'Read {a}.' } }] });
  let faux: ReturnType<typeof fauxProvider> | undefined;
  const streamFn: StreamFn = (model, context, options) => {
    if (!faux) {
      faux = fauxProvider({ provider: model.provider, api: model.api });
      const oversized = { ...controlledResult, details: 'x'.repeat(260000) };
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read_a', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage(JSON.stringify(oversized)), fauxAssistantMessage(JSON.stringify(oversized)),
      ]);
    }
    return faux.provider.streamSimple(model, context, options);
  };
  const broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry({ streamFn }) }); data.cleanup(() => broker.close());
  const submitted = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(submitted.id);
  const run = projectRun(data.stateDir, submitted.id)!;
  assert.equal(run.status, 'ERROR'); assert.match(run.requests[0].error ?? '', /after one format repair: over_size/);
  assert.deepEqual(run.events.filter(event => event.type === 'executor.final.invalid').map(event => event.data), [{ attempt: 'initial', category: 'over_size' }, { attempt: 'repair', category: 'over_size' }]);
  assert.deepEqual(run.events.filter(event => event.type === 'executor.final.repair').map(event => event.data), [{ outcome: 'started' }, { outcome: 'failed' }]);
});
