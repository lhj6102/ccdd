import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectRequests, projectRun } from '../src/project/store.js';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { StreamFn } from '../src/executors/pi.js';
import type { ReviewRequest } from '../src/contracts.js';

type Turn = ReturnType<typeof fauxAssistantMessage> | Error | 'hang';
async function fixture(t: Parameters<typeof artifactFixture>[0], timeoutMs: number = agentProfile.timeoutMs) {
  const data = await artifactFixture(t), views = fixtureViews();
  views.agentTools!.note = { metadata: { description: 'Record a note for {artifactName}.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 65000 } }, required: ['text'], additionalProperties: false },
    resultKinds: ['json'], observation: 'content' }, script: { command: 'node', args: ['note.mjs'] } };
  await data.write('a', { name: 'a', views, critics: [{ id: 'review', title: 'Review', profile: { ...agentProfile, timeoutMs }, payload: { instruction: 'Read {a}.' } }] },
    { 'note.mjs': "let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.stringify({content:[{type:'json',data:{noted:JSON.parse(text).args.text.length}}],observation:{kind:'content'}}));" });
  return data;
}
/** A Broker whose Agent answers turn by turn; 'hang' waits until the review is aborted. */
function streamOf(turns: (turn: number) => Turn): StreamFn {
  let turn = 0, faux: ReturnType<typeof fauxProvider> | undefined;
  return (model, context, options) => {
    faux ??= fauxProvider({ provider: model.provider, api: model.api });
    const response = turns(++turn);
    if (response instanceof Error) throw response;
    faux.appendResponses([response === 'hang' ? async () => new Promise<never>((_resolve, reject) => {
      if (options?.signal?.aborted) reject(new Error('aborted'));
      else options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) : response]);
    return faux.provider.streamSimple(model, context, options);
  };
}
function scripted(data: Awaited<ReturnType<typeof fixture>>, turns: (turn: number) => Turn) {
  const broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: streamOf(turns) }) }); data.cleanup(() => broker.close());
  return broker;
}
const requestOf = (broker: ReturnType<typeof createBroker>, runId: string) => broker.getRun(runId)!.requests[0] as ReviewRequest;
const read = (startLine: number) => fauxToolCall('read_a', { startLine, lineCount: 1 });
const calls = (...toolCalls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(toolCalls, { stopReason: 'toolUse' });
const recordRows = (stateDir: string) => { const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true }); try { return Number(db.prepare('SELECT COUNT(*) AS n FROM tool_call_records').get()!.n); } finally { db.close(); } };
/** Leave the Run owned by a process that no longer exists, as a crashed worker does. */
const killOwner = (stateDir: string, runId: string) => {
  const db = new DatabaseSync(join(stateDir, 'broker.sqlite'));
  try {
    if (!db.prepare('UPDATE run_owners SET pid=?,process_identity=NULL WHERE run_id=?').run(2147483647, runId).changes)
      db.prepare('INSERT INTO run_owners(run_id,pid,process_identity,token,claimed_at) VALUES (?,?,?,?,?)').run(runId, 2147483647, null, 'dead-worker', new Date().toISOString());
  } finally { db.close(); }
};

test('a cancelled review keeps its calls in a record apart from metadata-only events, readable through the stored Run', async t => {
  const data = await fixture(t);
  let broker: ReturnType<typeof createBroker> | undefined, runId = '';
  broker = scripted(data, turn => {
    if (turn === 1) return calls(read(1));
    if (turn === 2) return calls(read(2), fauxToolCall('note_a', { text: 'claimed [1,4]' }));
    broker!.cancel(runId); return fauxAssistantMessage('PRIVATE_CRITIC_MESSAGE');
  });
  runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
  const request = requestOf(broker, runId);
  assert.equal(request.status, 'ERROR'); assert.equal(request.errorCode, 'REVIEW_CANCELED'); assert.equal(request.result, null);
  assert.deepEqual(request.toolCalls!.map(call => [call.name, call.arguments]), [['read_a', { startLine: 1, lineCount: 1 }], ['read_a', { startLine: 2, lineCount: 1 }], ['note_a', { text: 'claimed [1,4]' }]]);
  assert.ok(request.toolCalls!.every(call => typeof call.at === 'string' && call.observation?.artifactId === 'a'));
  assert.equal(request.toolCallsOmitted, undefined);
  // Events stay metadata-only; `run show` reads the record from the stored Run; compact views leave it out.
  const stored = projectRun(data.stateDir, runId)!;
  assert.ok(stored.events.length > 0 && stored.events.every(event => !JSON.stringify(event.data ?? {}).includes('claimed [1,4]')));
  assert.deepEqual(stored.requests[0].toolCalls, request.toolCalls);
  assert.equal((projectRequests(data.stateDir, runId)[0] as { toolCalls?: unknown }).toolCalls, undefined);
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE_CRITIC_MESSAGE/);
});

test('the record keeps the first 200 calls and at most 256 KiB of arguments, and counts the rest', async t => {
  // About 200 tool processes run in this review, so it needs more than the fixture's five seconds.
  const data = await fixture(t, 120_000), big = 'x'.repeat(60_000);
  const broker = scripted(data, turn => turn === 1 ? calls(...Array.from({ length: 203 }, (_, index) => fauxToolCall('note_a', { text: String(index) }))) : new Error('fetch failed: PRIVATE_PROVIDER_DETAIL'));
  const runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
  let request = requestOf(broker, runId);
  assert.equal(request.toolCalls!.length, 200); assert.deepEqual(request.toolCalls!.at(-1)!.arguments, { text: '199' });
  assert.equal(request.toolCallsOmitted, 3);
  // A retry purges the failed attempt. Four 60 KB notes fit; the fifth and every later call are only counted.
  const retried = scripted(data, turn => turn === 1 ? calls(...Array.from({ length: 5 }, () => fauxToolCall('note_a', { text: big })), read(1)) : new Error('fetch failed: PRIVATE_PROVIDER_DETAIL'));
  retried.retryRequest(request.id); await retried.run(runId);
  request = requestOf(retried, runId);
  assert.deepEqual(request.toolCalls!.map(call => (call.arguments as { text: string }).text.length), [60_000, 60_000, 60_000, 60_000]);
  assert.equal(request.toolCallsOmitted, 2);
  assert.equal(recordRows(data.stateDir), 6);
  assert.doesNotMatch(JSON.stringify(projectRun(data.stateDir, runId)), /PRIVATE_PROVIDER_DETAIL/);
});

test('a worker that dies mid-review leaves its record, and a reopened store still reads it', async t => {
  const data = await fixture(t);
  let started!: () => void; const hanging = new Promise<void>(resolve => { started = resolve; });
  const broker = scripted(data, turn => { if (turn === 1) return calls(read(1), read(2)); started(); return 'hang'; });
  const runId = (await broker.submitProject({ selection: { kind: 'all' } })).id;
  const running = broker.run(runId).catch(() => {});
  await hanging; killOwner(data.stateDir, runId);
  const client = createBroker({ ...data, detail: 'full' });
  const request = requestOf(client, runId);
  assert.equal(request.status, 'ERROR'); assert.equal(request.errorCode, 'WORKER_EXITED');
  assert.deepEqual(request.toolCalls!.map(call => call.arguments), [{ startLine: 1, lineCount: 1 }, { startLine: 2, lineCount: 1 }]);
  await Promise.race([running, delay(5000)]); await client.close(); await broker.close();
  assert.deepEqual(projectRun(data.stateDir, runId)!.requests[0].toolCalls, request.toolCalls);
});

test('a retry that fails before its executor starts shows no calls from the earlier attempt', async t => {
  type Data = Awaited<ReturnType<typeof fixture>>;
  const failures: Record<string, (data: Data, runId: string, requestId: string) => Promise<ReviewRequest>> = {
    unavailable: async (data, runId, requestId) => {
      const refusing = { ...createExecutorRegistry(), canExecute: async () => ({ ok: false, reason: 'No Agent executor.', code: 'EXECUTOR_UNAVAILABLE' }) };
      const broker = createBroker({ ...data, detail: 'full', executors: refusing }); data.cleanup(() => broker.close());
      broker.retryRequest(requestId); await broker.run(runId); return requestOf(broker, runId);
    },
    cancelled: async (data, runId, requestId) => {
      const broker = createBroker({ ...data, detail: 'full' }); data.cleanup(() => broker.close());
      broker.retryRequest(requestId); broker.cancel(runId); return requestOf(broker, runId);
    },
    died: async (data, runId, requestId) => {
      const broker = createBroker({ ...data, detail: 'full' }); data.cleanup(() => broker.close());
      broker.retryRequest(requestId); killOwner(data.stateDir, runId); return requestOf(broker, runId);
    },
  };
  for (const [name, fail] of Object.entries(failures)) {
    const data = await fixture(t);
    const broker = scripted(data, turn => turn === 1 ? calls(read(1)) : new Error('fetch failed'));
    const runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
    const first = requestOf(broker, runId);
    assert.equal(first.toolCalls!.length, 1, name);
    const retried = await fail(data, runId, first.id);
    assert.equal(retried.status, 'ERROR', name); assert.notEqual(retried.errorCode, first.errorCode, name);
    assert.equal(retried.toolCalls, undefined, name); assert.equal(retried.toolCallsOmitted, undefined, name);
  }
});

test('a review that returns a result keeps its calls only in the result', async t => {
  const data = await fixture(t);
  const broker = scripted(data, turn => turn === 1 ? calls(read(1)) : fauxAssistantMessage('{"verdict":"GREEN"}'));
  const runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
  const request = requestOf(broker, runId);
  assert.equal(request.status, 'GREEN'); assert.equal(request.result!.toolCalls!.length, 1);
  assert.equal(request.toolCalls, undefined); assert.equal(recordRows(data.stateDir), 0);
});
