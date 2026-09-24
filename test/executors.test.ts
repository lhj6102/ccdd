import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExecutorRegistry } from '../src/executors/index.js';
import { artifactFixture, fixtureViews, agentProfile, runtimeCritic } from './helpers/artifacts.js';
import { artifactStream } from './pi-fixture.js';
import { normalizeReviewResult, createReviewResultSizeCheck } from '../src/review-result.js';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { ReviewToolCall } from '../src/contracts.js';
import type { ExecutionEvent } from '../src/contracts.js';

test('Agent evaluates only required target and explicit references and keeps its payload unchanged', async t => {
  const data = await artifactFixture(t);
  await data.write('style', { name: 'style', basis: true, views: fixtureViews() });
  await data.write('service', { name: 'service', views: fixtureViews(), mounts: { guide: 'style' }, critics: [{ id: 'style', title: 'Check style', profile: agentProfile, payload: { instruction: 'Use {guide} for {service}. Keep \\{literal}.' } }] });
  await data.write('service/assets', { name: 'assets', basis: true });
  const [request] = await data.requests(), original = structuredClone(request), events: ExecutionEvent[] = [];
  let prompt = '';
  const result = await createExecutorRegistry({ streamFn: artifactStream({ onRequest: ({ context }) => { prompt = JSON.stringify(context.messages[0]?.content); } }) }).execute(request, { worktreePath: data.repoPath, runDir: join(data.root, 'run'), onEvent: event => { events.push(event); } });
  assert.equal(result.verdict, 'GREEN'); assert.deepEqual(result.toolCalls?.map(call => call.name), ['read_service', 'read_style']);
  assert.deepEqual(request, original); assert.match(prompt, /read_style/); assert.match(prompt, /literal/);
  assert.equal(events.filter(event => event.type === 'artifact.tool.called').length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING/);
});

test('missing content observations and invalid structured verdicts remain errors rather than RED', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  const [request] = await data.requests(), context = { worktreePath: data.repoPath, runDir: join(data.root, 'run') };
  for (const mode of ['no-tools', 'beyond-eof', 'malformed', 'unknown-error'] as const) await assert.rejects(createExecutorRegistry({ streamFn: artifactStream({ mode }) }).execute(request, context));
  for (const result of [{ verdict: 'GREEN', summary: 'Okay', evidence: [], extra: true }, { verdict: 'GREEN', summary: '', evidence: ['Fixture'] }]) await assert.rejects(createExecutorRegistry({ streamFn: artifactStream({ result }) }).execute(request, context));
});

test('Runtime resolves a logical mount to real test paths and reports actual assertion failures', async t => {
  const data = await artifactFixture(t);
  await data.write('tests', { name: 'tests', basis: true });
  const critic = runtimeCritic(); critic.profile = { kind: 'runtime', command: 'node', args: ['--test', 'suite/check.test.mjs'] };
  await data.write('implementation', { name: 'implementation', mounts: { suite: 'tests' }, critics: [critic] });
  const [request] = await data.requests(), registry = createExecutorRegistry(), context = { worktreePath: data.repoPath, runDir: join(data.root, 'run') };
  assert.equal((await registry.execute(request, context)).verdict, 'GREEN');
  await writeFile(join(data.repoPath, 'tests/check.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';test('actual failure',()=>assert.equal(1,2));");
  const failed = await registry.execute(request, context); assert.equal(failed.verdict, 'RED'); assert.equal(failed.exitCode, 1);
});

test('concurrent Runtime executions use the Artifact cwd and separate writable outputs, temporary files and homes', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [runtimeCritic()] }, { 'check.test.mjs': "import {writeFile} from 'node:fs/promises';await writeFile(process.env.CCDD_OUTPUT_DIR+'/receipt.json',JSON.stringify({cwd:process.cwd(),tmp:process.env.TMPDIR,home:process.env.HOME,output:process.env.CCDD_OUTPUT_DIR}));" });
  const [request] = await data.requests(), registry = createExecutorRegistry();
  await Promise.all(['one', 'two'].map(name => registry.execute(request, { worktreePath: data.repoPath, runDir: join(data.root, name) })));
  const results = await Promise.all(['one', 'two'].map(async name => JSON.parse(await readFile(join(data.root, name, 'output/receipt.json'), 'utf8'))));
  assert.equal(results[0].cwd, join(data.repoPath, 'a')); assert.notEqual(results[0].output, results[1].output); assert.notEqual(results[0].tmp, results[1].tmp); assert.notEqual(results[0].home, results[1].home);
  await assert.rejects(registry.execute(request, { worktreePath: data.repoPath, runDir: join(data.repoPath, 'outputs') }), /outside/);
});

test('Human notifications use registered alarms and never invoke the Agent transport', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'human', title: 'Human', profile: { kind: 'human' }, payload: { instruction: 'Inspect {a}.' } }] });
  const [request] = await data.requests(); let alarms = 0;
  const registry = createExecutorRegistry({ alarmMethods: [async () => { alarms++; }], streamFn: () => { throw new Error('Must not execute Provider.'); } });
  assert.equal((await registry.canExecute(request)).ok, true); await registry.notifyHuman(request as any); assert.equal(alarms, 1);
  await assert.rejects(registry.execute(request, { worktreePath: data.repoPath, runDir: join(data.root, 'run') }), /claim\/result/);
  assert.equal((await createExecutorRegistry().canExecute(request)).ok, false);
});

for (const repair of [false, true]) test(`Agent accepts the exact persisted-envelope limit with its actual duration (repair=${repair})`, async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {a}.' } }] });
  const [request] = await data.requests(), toolCalls: ReviewToolCall[] = [], events: ExecutionEvent[] = [];
  let clock = 100_000, turns = 0, faux: ReturnType<typeof fauxProvider> | undefined;
  t.mock.method(Date, 'now', () => clock);
  const result = await createExecutorRegistry({ streamFn: (model, context, options) => {
    faux ??= fauxProvider({ provider: model.provider, api: model.api });
    turns++;
    if (turns === 1) faux.appendResponses([fauxAssistantMessage([fauxToolCall('read_a', {})], { stopReason: 'toolUse' })]);
    else if (repair && turns === 2) faux.appendResponses([fauxAssistantMessage('not json')]);
    else {
      assert.equal(turns, repair ? 3 : 2, 'must not repair an already valid boundary result');
      clock = 100_123;
      const final = { verdict: 'GREEN', summary: 'Observed input.', evidence: [...Array(63).fill('x'.repeat(4000)), 'x'] };
      const base = normalizeReviewResult({ ...final, provider: agentProfile.provider, model: agentProfile.model, toolCalls, durationMs: 123 });
      final.evidence[63] += 'x'.repeat(256_000 - JSON.stringify(base).length);
      assert.ok(final.evidence[63].length <= 4000);
      faux.appendResponses([fauxAssistantMessage(JSON.stringify(final))]);
    }
    return faux.provider.streamSimple(model, context, options);
  } }).execute(request, { worktreePath: data.repoPath, runDir: join(data.root, 'run'), onEvent: event => {
    events.push(event);
    if (event.type === 'artifact.tool.called') toolCalls.push(event as unknown as ReviewToolCall);
    // Diagnostic delivery after acceptance must not change the envelope's checked duration.
    if (event.type === 'executor.final.repair' && event.outcome === 'succeeded') clock += 10_000;
  } });
  assert.equal(result.durationMs, 123);
  assert.equal(JSON.stringify(normalizeReviewResult(result)).length, 256_000);
  assert.equal(events.filter(event => event.type === 'executor.final.invalid').length, repair ? 1 : 0);
});

for (const oversized of [false, true]) test(`immutable result metadata is measured once even when over-limit (${oversized})`, () => {
  let copies = 0;
  const argumentsWithCounter = { toJSON() { copies++; return { payload: 'x'.repeat(oversized ? 256_000 : 1000) }; } };
  const check = createReviewResultSizeCheck({ toolCalls: [{ name: 'read_a', arguments: argumentsWithCounter }] });
  const final = { verdict: 'GREEN', summary: 'Observed input.', evidence: ['Observed input.'], durationMs: 123 };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (oversized) assert.throws(() => check(final), /exceeds the supported size/);
    else assert.deepEqual(check(final), final);
  }
  assert.equal(copies, 1);
});
