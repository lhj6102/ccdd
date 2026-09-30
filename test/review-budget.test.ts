import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { inspectProject } from '../src/project/index.js';
import type { AgentProfile, ExecutionEvent } from '../src/contracts.js';
import type { StreamFn } from '../src/executors/pi.js';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';

const read = (startLine: number) => fauxToolCall('read_a', { startLine, lineCount: 1 });
const toolTurn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: 'toolUse' });
function scripted(messages: ReturnType<typeof fauxAssistantMessage>[]): StreamFn {
  let faux: ReturnType<typeof fauxProvider> | undefined;
  return (model, context, options) => {
    if (!faux) { faux = fauxProvider({ provider: model.provider, api: model.api }); faux.setResponses(messages); }
    return faux.provider.streamSimple(model, context, options);
  };
}
async function budgeted(t: Parameters<typeof artifactFixture>[0], budget: Partial<AgentProfile>, messages: ReturnType<typeof fauxAssistantMessage>[]) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: { ...agentProfile, ...budget }, payload: { instruction: 'Read {a}.' } }] });
  const [request] = await data.requests(), events: ExecutionEvent[] = [];
  const review = createExecutorRegistry({ streamFn: scripted(messages) }).execute(request, { worktreePath: data.repoPath, runDir: join(data.root, 'run'), onEvent: event => { events.push(event); } });
  return { review, events, called: () => events.filter(event => event.type === 'artifact.tool.called').length };
}

test('maxToolCalls ends the review at the first call over the budget, across turns and within one turn', async t => {
  for (const messages of [[toolTurn(read(1)), toolTurn(read(2)), toolTurn(read(3)), fauxAssistantMessage('{"verdict":"GREEN"}')], [toolTurn(read(1), read(2), read(3)), fauxAssistantMessage('{"verdict":"GREEN"}')]]) {
    const { review, called } = await budgeted(t, { maxToolCalls: 2 }, messages);
    await assert.rejects(review, { code: 'PROVIDER_BUDGET_EXCEEDED', message: 'The review exceeded its maxToolCalls budget.' });
    assert.equal(called(), 2);
  }
  const within = await budgeted(t, { maxToolCalls: 2 }, [toolTurn(read(1)), toolTurn(read(2)), fauxAssistantMessage('{"verdict":"GREEN"}')]);
  assert.equal((await within.review).verdict, 'GREEN');
});

test('maxTokens ends the review at the model turn that crosses it, before that turn\'s tools run', async t => {
  const messages = () => [toolTurn(read(1)), fauxAssistantMessage('{"verdict":"GREEN"}')];
  const crossed = await budgeted(t, { maxTokens: 1 }, messages());
  await assert.rejects(crossed.review, { code: 'PROVIDER_BUDGET_EXCEEDED', message: 'The review exceeded its maxTokens budget.' });
  assert.equal(crossed.called(), 0);
  // The limit counts Pi's reported totalTokens: the first turn alone already exceeds one token.
  assert.ok(crossed.events.some(event => event.type === 'executor.usage' && (event.usage as { totalTokens: number }).totalTokens > 1));
  const ample = await budgeted(t, { maxTokens: 1_000_000, maxToolCalls: 10 }, messages());
  assert.equal((await ample.review).verdict, 'GREEN'); assert.equal(ample.called(), 1);
});

test('a budget stop is an operational ERROR, and a budget edit is an ordinary ccdd.json input edit like timeoutMs', async t => {
  const data = await artifactFixture(t);
  const write = (budget: Partial<AgentProfile>) => data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: { ...agentProfile, ...budget }, payload: { instruction: 'Read {a}.' } }] });
  for (const invalid of [{ maxToolCalls: 0 }, { maxTokens: 1.5 }, { maxTokens: '1000' as unknown as number }]) {
    await write(invalid); await assert.rejects(data.config(), /must be a positive integer/);
  }
  await write({});
  const key = async () => (await inspectProject({ ...data, detail: 'full' })).snapshot.inputs['a/review'].key;
  // Default identity hashes the declaration file itself, so a changed budget, like a changed timeoutMs, reviews again.
  const unbudgeted = await key();
  await write({ maxToolCalls: 1 }); const budgeted = await key(); assert.notEqual(budgeted, unbudgeted);
  await write({ maxToolCalls: 1, timeoutMs: 6000 }); assert.notEqual(await key(), budgeted);
  await write({ maxToolCalls: 1 });
  const broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: scripted([toolTurn(read(1)), toolTurn(read(2)), fauxAssistantMessage('{"verdict":"GREEN"}')]) }) });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const completed = broker.getRun(run.id)!;
  assert.equal(completed.status, 'ERROR');
  assert.equal(completed.requests[0].errorCode, 'PROVIDER_BUDGET_EXCEEDED'); assert.equal(completed.requests[0].result, null);
});

test('maxToolCalls counts every tool-call block the model issues, unknown names included, and runs no later tool', async t => {
  const unknown = () => fauxToolCall('missing_tool', {});
  // Two unknown calls use up a limit of one before a registered tool is ever reached.
  const separate = await budgeted(t, { maxToolCalls: 1 }, [toolTurn(unknown()), toolTurn(unknown()), toolTurn(read(1)), fauxAssistantMessage('{"verdict":"GREEN"}')]);
  await assert.rejects(separate.review, { code: 'PROVIDER_BUDGET_EXCEEDED' }); assert.equal(separate.called(), 0);
  // In one batch, calls within the limit still run; the first over-limit call and everything after it do not.
  const mixed = await budgeted(t, { maxToolCalls: 2 }, [toolTurn(read(1), unknown(), read(2), read(3)), fauxAssistantMessage('{"verdict":"GREEN"}')]);
  await assert.rejects(mixed.review, { code: 'PROVIDER_BUDGET_EXCEEDED' });
  assert.deepEqual(mixed.events.filter(event => event.type === 'artifact.tool.called').map(event => (event.arguments as { startLine: number }).startLine), [1]);
});

/** Pre-completed turns with explicit usage; `before` runs as the turn is requested, e.g. to cancel. */
function crafted(turns: { message: ReturnType<typeof fauxAssistantMessage>; totalTokens: number; before?: () => void }[]): StreamFn {
  let turn = 0;
  return model => {
    const { message: base, totalTokens, before } = turns[turn++];
    before?.();
    const message = { ...base, provider: model.provider, model: model.id, api: model.api,
      usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
  };
}

test('cancellation that races an over-budget turn stays a cancellation, directly and through the Broker', async t => {
  for (const budget of [{ maxTokens: 150 }, { maxToolCalls: 1 }]) {
    const data = await artifactFixture(t);
    await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: { ...agentProfile, ...budget }, payload: { instruction: 'Read {a}.' } }] });
    const external = new AbortController(), [request] = await data.requests();
    const direct = createExecutorRegistry({ streamFn: crafted([{ message: toolTurn(read(1)), totalTokens: 100 },
      { message: toolTurn(read(2)), totalTokens: 100, before: () => external.abort() }]) })
      .execute(request, { worktreePath: data.repoPath, runDir: join(data.root, 'run'), signal: external.signal });
    await assert.rejects(direct, { code: 'ABORTED' }, JSON.stringify(budget));
    let broker: ReturnType<typeof createBroker> | undefined, runId = '';
    broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: crafted([{ message: toolTurn(read(1)), totalTokens: 100 },
      { message: toolTurn(read(2)), totalTokens: 100, before: () => broker!.cancel(runId) }]) }) });
    data.cleanup(() => broker!.close());
    runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
    assert.equal(broker.getRun(runId)!.requests[0].errorCode, 'REVIEW_CANCELED', JSON.stringify(budget));
  }
});
