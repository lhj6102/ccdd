import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectRequests, projectRun } from '../src/project/store.js';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { StreamFn } from '../src/executors/pi.js';
import type { ReviewRequest } from '../src/contracts.js';

type Turn = (turn: number, cancel: () => void) => ReturnType<typeof fauxAssistantMessage> | Error;
async function review(t: Parameters<typeof artifactFixture>[0], turns: Turn) {
  const data = await artifactFixture(t), views = fixtureViews();
  views.agentTools!.note = { metadata: { description: 'Record a note for {artifactName}.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 65000 } }, required: ['text'], additionalProperties: false },
    resultKinds: ['json'], observation: 'content' }, script: { command: 'node', args: ['note.mjs'] } };
  await data.write('a', { name: 'a', views, critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] },
    { 'note.mjs': "let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.stringify({content:[{type:'json',data:{noted:JSON.parse(text).args.text.length}}],observation:{kind:'content'}}));" });
  let broker: ReturnType<typeof createBroker> | undefined, runId = '', turn = 0, faux: ReturnType<typeof fauxProvider> | undefined;
  const streamFn: StreamFn = (model, context, options) => {
    faux ??= fauxProvider({ provider: model.provider, api: model.api });
    const response = turns(++turn, () => broker!.cancel(runId));
    if (response instanceof Error) throw response;
    faux.appendResponses([response]);
    return faux.provider.streamSimple(model, context, options);
  };
  broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn }) }); data.cleanup(() => broker!.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); runId = run.id;
  await broker.run(run.id);
  return { data, broker, runId: run.id };
}
const requestOf = (broker: ReturnType<typeof createBroker>, runId: string) => broker.getRun(runId)!.requests[0] as ReviewRequest;
const read = (startLine: number) => fauxToolCall('read_a', { startLine, lineCount: 1 });
const calls = (...toolCalls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(toolCalls, { stopReason: 'toolUse' });

test('a cancelled review keeps its recorded tool calls, in order, readable through the stored Run', async t => {
  const { data, broker, runId } = await review(t, (turn, cancel) => {
    if (turn === 1) return calls(read(1));
    if (turn === 2) return calls(read(2), fauxToolCall('note_a', { text: 'claimed [1,4]' }));
    cancel(); return fauxAssistantMessage('PRIVATE_CRITIC_MESSAGE');
  });
  const request = requestOf(broker, runId);
  assert.equal(request.status, 'ERROR'); assert.equal(request.errorCode, 'REVIEW_CANCELED'); assert.equal(request.result, null);
  assert.deepEqual(request.toolCalls!.map(call => [call.name, call.arguments]), [['read_a', { startLine: 1, lineCount: 1 }], ['read_a', { startLine: 2, lineCount: 1 }], ['note_a', { text: 'claimed [1,4]' }]]);
  assert.ok(request.toolCalls!.every(call => typeof call.at === 'string' && call.observation?.artifactId === 'a'));
  assert.equal(request.toolCallsOmitted, undefined);
  // `run show` reads the same record from the stored Run; compact projections leave it out.
  const stored = projectRun(data.stateDir, runId)!.requests[0];
  assert.deepEqual(stored.toolCalls, request.toolCalls);
  assert.equal((projectRequests(data.stateDir, runId)[0] as { toolCalls?: unknown }).toolCalls, undefined);
  assert.doesNotMatch(JSON.stringify(projectRun(data.stateDir, runId)), /PRIVATE_CRITIC_MESSAGE/);
});

test('a failed review records its last attempt only, with an explicit marker past the argument bound', async t => {
  const big = 'x'.repeat(60_000);
  const { data, broker, runId } = await review(t, turn => {
    if (turn === 1) return calls(read(1));
    if (turn === 2) return new Error('fetch failed: PRIVATE_PROVIDER_DETAIL');
    // The retried attempt: four 60 KB notes fit the 256 KiB bound, the fifth and anything later do not.
    if (turn === 3) return calls(...Array.from({ length: 5 }, () => fauxToolCall('note_a', { text: big })), read(3));
    return new Error('fetch failed: PRIVATE_PROVIDER_DETAIL');
  });
  const first = requestOf(broker, runId);
  assert.equal(first.status, 'ERROR'); assert.deepEqual(first.toolCalls!.map(call => call.arguments), [{ startLine: 1, lineCount: 1 }]);
  broker.retryRequest(first.id); await broker.run(runId);
  const retried = requestOf(broker, runId);
  assert.equal(retried.status, 'ERROR');
  assert.deepEqual(retried.toolCalls!.map(call => call.name), ['note_a', 'note_a', 'note_a', 'note_a']);
  assert.equal(retried.toolCalls![0].arguments && (retried.toolCalls![0].arguments as { text: string }).text.length, 60_000);
  assert.equal(retried.toolCallsOmitted, 2);
  assert.doesNotMatch(JSON.stringify(projectRun(data.stateDir, runId)), /PRIVATE_PROVIDER_DETAIL/);
});

test('a review that returns a result keeps its calls in the result, not in a second record', async t => {
  const { broker, runId } = await review(t, turn => turn === 1 ? calls(read(1)) : fauxAssistantMessage('{"verdict":"GREEN"}'));
  const request = requestOf(broker, runId);
  assert.equal(request.status, 'GREEN'); assert.equal(request.result!.toolCalls!.length, 1);
  assert.equal(request.toolCalls, undefined); assert.equal(request.toolCallsOmitted, undefined);
});
