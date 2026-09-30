import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectRequests, projectRun } from '../src/project/store.js';
import type { ReviewRequest } from '../src/contracts.js';
import type { StreamFn } from '../src/executors/pi.js';
import { artifactFixture, fixtureViews, agentProfile } from './helpers/artifacts.js';

type Turn = { message: ReturnType<typeof fauxAssistantMessage>; usage: number; before?: () => void };
const usageOf = (tokens: number) => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
/** Pre-completed turns with explicit usage, scripted per Critic from the first prompt's Critic line. */
function perCritic(scripts: Record<string, (turn: number) => Turn>): StreamFn {
  const turns: Record<string, number> = {};
  return (model, context: TranscriptContext) => {
    const first = context.messages.find(message => message.role === 'user')!;
    const text = typeof first.content === 'string' ? first.content : first.content.map(block => block.type === 'text' ? block.text : '').join('');
    const critic = Object.keys(scripts).find(id => text.includes(`(${id})`))!;
    const { message: base, usage, before } = scripts[critic]((turns[critic] = (turns[critic] ?? 0) + 1));
    before?.();
    const message = { ...base, provider: model.provider, model: model.id, api: model.api, usage: usageOf(usage) };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
  };
}
const toolTurn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: 'toolUse' });
const green = fauxAssistantMessage('{"verdict":"GREEN"}');
const byCritic = (requests: ReviewRequest[], id: string) => requests.find(request => request.criticId === id)!;

test('each request sums its own usage, independent of the Run\'s latest-500 event window', async t => {
  const data = await artifactFixture(t), profile = { ...agentProfile, timeoutMs: 60_000 };
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review A', profile, payload: { instruction: 'Read {a}.' } }] });
  // b references a, so it waits for a; its 520 turns then push a's events out of the window.
  await data.write('b', { name: 'b', views: fixtureViews(), critics: [{ id: 'review', title: 'Review B', profile, payload: { instruction: 'Read {b} with {a}.' } }] });
  const broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: perCritic({
    'a/review': turn => turn === 1 ? { message: toolTurn(fauxToolCall('read_a', { startLine: 1, lineCount: 1 })), usage: 100 } : { message: green, usage: 50 },
    'b/review': turn => turn === 1 ? { message: toolTurn(fauxToolCall('read_b', { startLine: 1, lineCount: 1 }), fauxToolCall('read_a', { startLine: 1, lineCount: 1 })), usage: 1 }
      : turn <= 521 ? { message: toolTurn(fauxToolCall('missing_tool', {})), usage: 1 } : { message: green, usage: 10 },
  }) }) });
  data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const stored = projectRun(data.stateDir, run.id)!, a = byCritic(stored.requests, 'a/review'), b = byCritic(stored.requests, 'b/review');
  assert.equal(stored.status, "GREEN", JSON.stringify(stored.requests.map(r => [r.criticId, r.status, r.errorCode, r.error])));
  // The window lost every usage event of a, but the request itself still carries its totals.
  assert.equal(stored.events.filter(event => event.requestId === a.id && event.type === 'executor.usage').length, 0);
  assert.deepEqual(a.usage, { input: 150, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 150 });
  assert.deepEqual(b.usage, { input: 531, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 531 });
  // Wall time and calls were already on every request.
  assert.ok(a.startedAt && a.completedAt); assert.equal(a.result!.toolCalls!.length, 1);
  assert.ok(projectRequests(data.stateDir, run.id).every(request => !('usage' in request)));
});

test('usage covers a cancelled attempt up to cancellation and starts again with a retry', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review A', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  let broker: ReturnType<typeof createBroker> | undefined, runId = '';
  broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: perCritic({
    'a/review': turn => turn === 1 ? { message: toolTurn(fauxToolCall('read_a', { startLine: 1, lineCount: 1 })), usage: 100 }
      : { message: green, usage: 7, before: () => broker!.cancel(runId) },
  }) }) });
  data.cleanup(() => broker!.close());
  runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
  let request = broker.getRun(runId)!.requests[0] as ReviewRequest;
  assert.equal(request.errorCode, 'REVIEW_CANCELED'); assert.equal(request.usage!.totalTokens, 100);
  broker.retryRequest(request.id); broker.cancel(runId);
  request = broker.getRun(runId)!.requests[0] as ReviewRequest;
  assert.equal(request.status, 'ERROR'); assert.equal(request.usage, undefined);
});

const single = (usage: number) => perCritic({ 'a/review': turn => turn === 1 ? { message: toolTurn(fauxToolCall('read_a', { startLine: 1, lineCount: 1 })), usage } : { message: green, usage: 0 } });
async function oneReview(t: Parameters<typeof artifactFixture>[0], usage: number, prepare?: (db: DatabaseSync) => void) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review A', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  const broker = createBroker({ ...data, detail: 'full', executors: createExecutorRegistry({ streamFn: single(usage) }) }); data.cleanup(() => broker.close());
  if (prepare) { const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); try { prepare(db); } finally { db.close(); } }
  const runId = (await broker.submitProject({ selection: { kind: 'all' } })).id; await broker.run(runId);
  return { data, broker, runId, request: () => broker.getRun(runId)!.requests[0] as ReviewRequest };
}

test('usage shows only the sum of the attempt that set attemptId, never one left by another attempt', async t => {
  const { data, request } = await oneReview(t, 7);
  const current = request();
  assert.equal(current.status, 'GREEN'); assert.equal(current.usage!.totalTokens, 7);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  try {
    // An earlier attempt's sum stays hidden; so does it after a retry under a build that kept no sum for the new attempt.
    db.prepare('INSERT INTO request_usage(request_id,attempt_id,data) VALUES (?,?,?)').run(current.id, 'previous-attempt', JSON.stringify({ input: 100, totalTokens: 100 }));
    assert.equal(request().usage!.totalTokens, 7);
    db.prepare('DELETE FROM request_usage WHERE request_id=? AND attempt_id=?').run(current.id, current.attemptId!);
  } finally { db.close(); }
  assert.equal(request().usage, undefined);
});

test('a usage event that cannot be stored leaves the attempt sum unchanged', async t => {
  const { data, broker, runId, request } = await oneReview(t, 9, db =>
    db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON events WHEN NEW.type='executor.usage' BEGIN SELECT RAISE(ABORT,'rejected'); END;"));
  assert.equal(request().status, 'GREEN');
  assert.equal(broker.getRun(runId)!.events.filter(event => event.type === 'executor.usage').length, 0);
  assert.equal(request().usage, undefined);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'), { readOnly: true });
  try { assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM request_usage').get()!.n), 0); } finally { db.close(); }
});
