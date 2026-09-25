import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';
import { artifactStream } from './pi-fixture.js';
import { runUntilSettled } from './helpers/run.js';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const failSchema = { type: 'object', properties: { reasons: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Concrete unmet requirements.' } }, required: ['reasons'] };

for (const human of [false, true]) test(`owner response fields apply equally to ${human ? 'Human' : 'Agent'} results without truncation`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: human ? { kind: 'human' } : agentProfile, failSchema, payload: { instruction: 'Read {a}.' } }] });
  const reasons = ['x'.repeat(16000)];
  const broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ alarmMethods: [async () => {}], streamFn: artifactStream({ result: { verdict: 'RED', reasons } }) }) });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  if (human) {
    await runUntilSettled(broker, run.id);
    const id = run.requests[0].id; await broker.claimHuman(id, 'reader');
    await assert.rejects(broker.completeHuman(id, { reviewerId: 'reader', result: { verdict: 'RED' } }), /schema/);
    await assert.rejects(broker.completeHuman(id, { reviewerId: 'reader', result: { verdict: 'GREEN', reasons } }), /schema/);
    await broker.executeHumanTool(id, { reviewerId: 'reader', toolName: 'read_a', arguments: {} });
    await broker.completeHuman(id, { reviewerId: 'reader', result: { verdict: 'RED', reasons } });
  } else await broker.run(run.id);
  const result = broker.getRun(run.id)!.requests[0].result!;
  assert.equal(result.verdict, 'RED'); assert.deepEqual(result.reasons, reasons);
  assert.equal(result.summary, undefined); assert.equal(result.evidence, undefined);
});

test('owner schema mismatch receives exactly one format-only repair in the actual Agent loop', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, failSchema, payload: { instruction: 'Read {a}.' } }] });
  let faux: ReturnType<typeof fauxProvider> | undefined, calls = 0;
  const broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: (model, context, options) => {
    calls++;
    if (!faux) { faux = fauxProvider({ provider: model.provider, api: model.api }); faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_a', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('{"verdict":"RED"}'), fauxAssistantMessage('{"verdict":"RED","reasons":["Missing behavior"]}'),
    ]); }
    return faux.provider.streamSimple(model, context, options);
  } }) }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const completed = broker.getRun(run.id)!;
  assert.equal(completed.status, 'RED'); assert.equal(calls, 3);
  assert.equal(completed.events.filter(event => event.type === 'executor.final.invalid').length, 1);
  assert.deepEqual(completed.requests[0].result!.reasons, ['Missing behavior']);
});

test('response schemas are static declarations and cannot overwrite reserved result fields', async t => {
  const data = await artifactFixture(t);
  for (const schema of [{ type: 'string' }, { type: 'object', properties: { toolCalls: { type: 'array' } } }, { type: 'object', properties: { reference: { type: 'string' } } }]) {
    await data.write('a', { name: 'a', critics: [{ id: 'review', title: 'Review', profile: agentProfile, passSchema: schema, payload: { instruction: 'Read.' } }] });
    await assert.rejects(data.config(), /schema|reserved|object/);
  }
});
