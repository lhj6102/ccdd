import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, hasApi, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as streamBedrock } from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { invokePi, validatePiProfile, type InvokePiOptions, type StreamFn } from '../src/executors/pi.js';
import { assertPiAuthFilesOutsideWorkspace, createPiCredentialStore } from '../src/executors/auth.js';
import type { AgentProfile, ExecutionEvent, ReviewEnvelope } from '../src/contracts.js';
import { artifactFixture, fixtureViews } from './helpers/artifacts.js';
import { artifactStream } from './pi-fixture.js';

const schema = { type: 'object', required: ['verdict', 'summary', 'evidence'], additionalProperties: false, properties: { verdict: { type: 'string', enum: ['GREEN', 'RED'] }, summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } } };
const profile: AgentProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 5_000 };
const verdict = { verdict: 'GREEN', summary: 'Inspection complete', evidence: ['Inspected line 2 of spec.md.'] };

async function fixture(t: TestContext): Promise<InvokePiOptions & { dir: string }> {
  const data = await artifactFixture(t), dir = data.root, worktreePath = data.repoPath;
  await data.write('', { name: 'spec', views: fixtureViews(), critics: [{ id: 'review', title: 'Review Spec', profile: { ...profile }, payload: { instruction: 'Inspect Spec.' } }] }, { 'content.txt': '\uccab\uc9f8 \uc904\r\n\ub458\uc9f8 \uc904\r\n\uc14b\uc9f8 \uc904\n' });
  const [request] = await data.requests();
  return { dir, request, worktreePath, runDir: join(dir, 'run'), schema, makePrompt: ({ viewer, tools }) => `Review payload: ${JSON.stringify(request.payload)}\nArtifacts: ${JSON.stringify(viewer.listArtifacts())}\nTools: ${JSON.stringify(tools)}` };
}

function scripted(calls: unknown[]): StreamFn {
  let faux: ReturnType<typeof fauxProvider> | undefined;
  return (model, context, options) => {
    if (!faux) {
      faux = fauxProvider({ provider: model.provider, api: model.api });
      faux.setResponses([fauxAssistantMessage(calls.map(args => fauxToolCall('read_spec', args as Record<string, unknown>)), { stopReason: 'toolUse' }), fauxAssistantMessage(JSON.stringify(verdict))]);
    }
    return faux.provider.streamSimple(model, context, options);
  };
}

test('Pi Agent loop receives exact provider/model/reasoning and scoped tools across models and providers', async t => {
  for (const settings of [profile, { ...profile, model: 'gpt-5.6-sol' }, { ...profile, provider: 'anthropic', model: 'claude-haiku-4-5', reasoning: 'high' }]) {
    const data = await fixture(t);
    data.request.profile = settings;
    const events: ExecutionEvent[] = [];
    let invocations = 0;
    const actual = await invokePi({ ...data, onEvent: event => { events.push(event); }, streamFn: artifactStream({ mode: 'partial', onRequest: ({ model, context, options }) => {
      invocations++;
      assert.equal(model.provider, settings.provider);
      assert.equal(model.id, settings.model);
      assert.equal(options?.reasoning, settings.reasoning);
      assert.deepEqual(context.tools?.map(tool => tool.name), ['read_spec']);
      assert.equal(context.tools?.[0]?.description, 'Read content from spec by line.');
      assert.equal((context.tools?.[0]?.parameters as { additionalProperties?: unknown }).additionalProperties, false);
    } }) });
    assert.equal(invocations, 2);
    assert.equal((actual.final as { verdict: string }).verdict, 'GREEN');
    assert.equal(actual.toolCalls.length, 1);
    assert.deepEqual(actual.toolCalls[0]?.arguments, { startLine: 2, lineCount: 1 });
    assert.equal(actual.toolCalls[0]?.observation?.kind, 'content');
    assert.equal(events.filter(event => event.type === 'artifact.tool.called').length, 1);
    assert.doesNotMatch(JSON.stringify({ actual, events }), /PRIVATE_REASONING|\ub458\uc9f8 \uc904/);
  }
});

test('Astra resolves exactly for both OpenAI providers and rejects unsupported effort instead of mapping it', () => {
  for (const provider of ['openai', 'openai-codex']) {
    for (const reasoning of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const model = validatePiProfile({ ...profile, provider, reasoning });
      assert.equal(model.id, 'gpt-6-astra');
      assert.equal(model.provider, provider);
      assert.equal(model.thinkingLevelMap?.[reasoning], reasoning);
    }
    for (const reasoning of ['off', 'minimal', 'ultra']) {
      assert.throws(() => validatePiProfile({ ...profile, provider, reasoning }), error => (error as { code: string }).code === 'REASONING_NOT_SUPPORTED');
    }
  }
});

test('Pi profile rejects unknown model/provider and reasoning substitutions before transport', () => {
  for (const settings of [
    { ...profile, provider: 'codex' }, { ...profile, model: 'ccdd-nonexistent-model' },
    { ...profile, reasoning: 'ultra' }, { ...profile, reasoning: 'minimal' }, { ...profile, reasoning: 'off' },
    { ...profile, timeoutMs: 1 },
  ]) assert.throws(() => validatePiProfile(settings));
  assert.equal(validatePiProfile({ ...profile, provider: 'openai', model: 'gpt-4.1', reasoning: 'off' }).id, 'gpt-4.1');
  assert.throws(() => validatePiProfile({ ...profile, provider: 'anthropic', model: 'claude-fable-5', reasoning: 'minimal' }));
});

test('Pi pre-validation rejects coercible/null/extra arguments and traversal without recording observations', async t => {
  const data = await fixture(t);
  const invalidArgs = [{ startLine: '2' }, { startLine: true }, { lineCount: null }, { lineCount: 501 }, { offset: 0 }, { path: '../outside.md' }, null];
  const actual = await invokePi({ ...data, streamFn: scripted(invalidArgs) });
  assert.equal(actual.toolCalls.length, 0);
  const good = await invokePi({ ...data, streamFn: scripted([{ startLine: 2, lineCount: 1 }]) });
  assert.equal(good.toolCalls.length, 1);
});

test('Pi provider failure, timeout and cancellation are errors rather than verdicts', async t => {
  for (const [mode, code] of [['auth-error', 'AUTHENTICATION_FAILED'], ['model-error', 'MODEL_ACCESS_FAILED'], ['network-error', 'PROVIDER_CONNECTION_FAILED'], ['throw', 'PROVIDER_EXECUTION_FAILED']] as const) {
    await assert.rejects(invokePi({ ...await fixture(t), streamFn: artifactStream({ mode }) }), error => {
      assert.equal((error as { code: string }).code, code); assert.doesNotMatch(String(error), /SECRET_TOKEN/); return true;
    });
  }
  const data = await fixture(t);
  data.request.profile = { ...profile, timeoutMs: 80 };
  await assert.rejects(invokePi({ ...data, streamFn: artifactStream({ mode: 'hang' }) }), /timed out/);
  const abort = new AbortController();
  const pending = invokePi({ ...data, request: { ...data.request, profile }, signal: abort.signal, streamFn: artifactStream({ mode: 'hang' }) });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, /aborted/);
  await assert.rejects(invokePi({ ...data, signal: AbortSignal.abort(), streamFn: artifactStream() }), /aborted/);
});

test('English authentication errors keep their specific classification after Provider transport', async t => {
  for (const [message, code] of [
    ['The authentication token has expired or will expire soon.', 'AUTHENTICATION_EXPIRED'],
    ['OpenAI Codex authentication files are configured in two places.', 'AUTHENTICATION_CONFLICT'],
    ['Cannot read the specified authentication file.', 'AUTHENTICATION_FAILED'],
  ]) {
    const data = await fixture(t);
    const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: `${message} SECRET_TOKEN_NOT_FOR_OUTPUT` })]);
    await assert.rejects(invokePi({ ...data, streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options) }), error => {
      assert.equal((error as { code: string }).code, code);
      assert.doesNotMatch(String(error), /SECRET_TOKEN/);
      return true;
    });
  }
});

test('explicit Pi credentials are read-only, support provider keys/OAuth, and reject expiry and workspace paths', async t => {
  const data = await fixture(t);
  const authFile = join(data.dir, 'auth.json');
  const original = JSON.stringify({ openai: { type: 'api_key', key: 'test-key-not-output' }, anthropic: { type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 3_600_000 } });
  await writeFile(authFile, original, { mode: 0o600 });
  const store = await createPiCredentialStore({ authFile }, data.worktreePath);
  assert.equal((await store.read('openai'))?.type, 'api_key');
  assert.equal((await store.read('anthropic'))?.type, 'oauth');
  assert.deepEqual(await store.list(), [{ providerId: 'openai', type: 'api_key' }, { providerId: 'anthropic', type: 'oauth' }]);
  assert.equal(await store.read('google'), undefined);
  let refreshed = false;
  await assert.rejects(store.modify('anthropic', async current => { refreshed = true; return current; }), /read-only/);
  assert.equal(refreshed, false);
  assert.equal(await readFile(authFile, 'utf8'), original);
  await writeFile(authFile, JSON.stringify({ anthropic: { type: 'oauth', access: 'SECRET_ACCESS', refresh: 'SECRET_REFRESH', expires: Date.now() } }));
  await assert.rejects(store.read('anthropic'), error => { assert.match(String(error), /expired/); assert.doesNotMatch(String(error), /SECRET_/); return true; });
  const inside = join(data.worktreePath, 'auth.json');
  await writeFile(inside, original);
  await assert.rejects((await createPiCredentialStore({ authFile: inside }, data.worktreePath)).read('openai'), /authentication file/i);
});

test('Codex bridge is explicit and access-only, never invokes refresh or writes the shared auth file', async t => {
  const data = await fixture(t);
  const codexAuthFile = join(data.dir, 'codex-auth.json');
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  const original = JSON.stringify({ tokens: { access_token: token, refresh_token: 'SHARED_REFRESH_NEVER_READ' } });
  await writeFile(codexAuthFile, original, { mode: 0o600 });
  assert.equal(await (await createPiCredentialStore({}, data.worktreePath)).read('openai-codex'), undefined);
  const store = await createPiCredentialStore({ codexAuthFile }, data.worktreePath);
  const actual = await store.read('openai-codex');
  assert.equal(actual?.type, 'oauth');
  if (actual?.type === 'oauth') { assert.equal(actual.access, token); assert.equal(actual.refresh, ''); }
  await assert.rejects(store.modify('openai-codex', async () => { throw new Error('must not run'); }), /read-only/);
  assert.equal(await readFile(codexAuthFile, 'utf8'), original);
  const authFile = join(data.dir, 'pi-auth.json');
  await writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'other', refresh: 'other', expires: Date.now() + 3_600_000 } }));
  await assert.rejects((await createPiCredentialStore({ codexAuthFile, authFile }, data.worktreePath)).read('openai-codex'), /two places/);
});

test('credential boundary checks the source before copy, including missing paths and canonical symlinks', async t => {
  const data = await fixture(t);
  const inside = join(data.worktreePath, 'auth.json');
  await assert.rejects(assertPiAuthFilesOutsideWorkspace({ authFile: inside }, data.worktreePath), /inside the review workspace/);
  await writeFile(inside, '{}');
  const link = join(data.dir, 'linked-auth.json');
  await symlink(inside, link);
  await assert.rejects(assertPiAuthFilesOutsideWorkspace({ codexAuthFile: link }, data.worktreePath), /inside the review workspace/);
  await assertPiAuthFilesOutsideWorkspace({ authFile: join(data.dir, 'snapshot-sibling', 'missing', 'auth.json') }, data.worktreePath);
});

test('Pi timeout and cancellation interrupt large skipped-line scans before a successful observation', async t => {
  const data = await fixture(t);
  const path = join(data.worktreePath, 'content.txt');
  await writeFile(path, '');
  // Sparse file: exercise a long scan without allocating gigabytes of disk space.
  await truncate(path, 2 * 1024 ** 3);
  const info = await stat(path);
  assert.ok(info.blocks * 512 < 1024 ** 2);
  for (const external of [false, true]) {
    const events: ExecutionEvent[] = [];
    const abort = new AbortController();
    const started = performance.now();
    const pending = invokePi({
      ...data, request: { ...data.request, profile: { ...profile, timeoutMs: external ? 5_000 : 80 } },
      signal: abort.signal, streamFn: artifactStream({ mode: 'partial' }), onEvent: event => { events.push(event); },
    });
    const timer = external ? setTimeout(() => abort.abort(), 80) : undefined;
    try { await assert.rejects(pending, external ? /aborted/ : /timed out/); }
    finally { clearTimeout(timer); }
    assert.ok(performance.now() - started < 1_000, 'A canceled scan must settle promptly without reading the rest of the sparse file');
    assert.equal(events.filter(event => event.type === 'artifact.tool.called').length, 0);
  }
});

test('Pi disables catalog model fallbacks and preserves native managed reasoning in each request', async () => {
  for (const modelId of ['claude-fable-5', 'claude-fable-5-1']) {
    for (const reasoning of ['low', 'medium'] as const) {
      const model = validatePiProfile({ ...profile, provider: 'anthropic', model: modelId, reasoning });
      assert.ok(hasApi(model, 'anthropic-messages'));
      let payload: { fallbacks?: unknown; output_config?: { effort?: string }; messages?: { role: string; output_config?: { effort?: string } }[] } | undefined;
      const result = await streamAnthropic(model, { messages: [{ role: 'user', content: 'Test payload only.', timestamp: Date.now() }] }, {
        apiKey: 'test-api-key', reasoning,
        onPayload(value) { payload = value as typeof payload; throw new Error('TEST_STOP_BEFORE_NETWORK'); },
      }).result();
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage ?? '', /TEST_STOP_BEFORE_NETWORK/);
      assert.ok(payload);
      assert.equal(payload.fallbacks, undefined);
      if (model.compat?.supportsMidConvoEffort) {
        // Pi's high prefix default is overridden by the effective per-turn level.
        assert.equal(payload.output_config?.effort, 'high');
        assert.equal(payload.messages?.at(-1)?.role, 'system');
        assert.equal(payload.messages?.at(-1)?.output_config?.effort, reasoning);
        assert.equal(result.providerThinkingLevel, reasoning);
      } else assert.equal(payload.output_config?.effort, reasoning);
    }
  }
});

test('every assistant response must identify the requested provider/model before its tools execute', async t => {
  for (const mismatch of ['provider', 'model', 'responseModel'] as const) {
    const data = await fixture(t);
    const events: ExecutionEvent[] = [];
    let attempts = 0;
    const streamFn: StreamFn = model => {
      attempts++;
      const message = { ...fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' }), provider: model.provider, model: model.id, api: model.api, [mismatch]: 'unrequested-value' };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end(message);
      return stream;
    };
    await assert.rejects(invokePi({ ...data, streamFn, onEvent: event => { events.push(event); } }), error => {
      assert.equal((error as { code: string }).code, 'PROVIDER_IDENTITY_MISMATCH'); return true;
    });
    assert.equal(attempts, 1);
    assert.equal(events.filter(event => event.type === 'artifact.tool.called').length, 0);
  }
});


for (const usage of [undefined, { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 4, totalTokens: 23, cost: { total: 999 }, secret: 'PRIVATE_USAGE' }, { input: -1, output: NaN, totalTokens: 1.5, cacheRead: 0 }]) test('Pi usage diagnostics preserve only counters actually reported by the executor', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const streamFn: StreamFn = model => {
    const stream = createAssistantMessageEventStream();
    const message = { ...fauxAssistantMessage(JSON.stringify(verdict)), provider: model.provider, model: model.id, api: model.api, usage } as unknown as ReturnType<typeof fauxAssistantMessage>;
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
    return stream;
  };
  const actual = await invokePi({ ...data, streamFn, onEvent: async event => { await new Promise(resolve => setTimeout(resolve, 5)); events.push(event); } });
  const reported = events.filter(event => event.type === 'executor.usage');
  assert.equal(reported.length, usage === undefined ? 0 : 1);
  if (usage) assert.deepEqual(reported[0].usage, usage.input === -1 ? { cacheRead: 0 } : { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 4, totalTokens: 23 });
  assert.doesNotMatch(JSON.stringify({ events, actual }), /PRIVATE_USAGE|cost|durationMs/);
});

test('completed Pi message usage survives a subsequent invalid final response', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  await assert.rejects(invokePi({ ...data, streamFn: artifactStream({ mode: 'malformed' }), onEvent: event => { events.push(event); } }), { code: 'PROVIDER_RESULT_INVALID' });
  assert.equal(events.filter(event => event.type === 'executor.usage').length, 3);
  const completed = events.find(event => event.type === 'artifact.tool.completed');
  assert.equal(completed?.outcome, 'success'); assert.ok(typeof completed?.durationMs === 'number');
});



for (const kind of ['executor.usage', 'artifact.tool.completed']) test(`a rejected ${kind} sink leaves the actual evaluation unchanged and reports a safe warning`, async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  let failures = 0;
  const result = await invokePi({ ...data, streamFn: artifactStream(), onEvent: event => {
    if (event.type === kind && failures++ === 0) throw new Error('PRIVATE_TELEMETRY_STORAGE');
    events.push(event);
  } });
  assert.equal((result.final as { verdict: string }).verdict, 'GREEN');
  assert.equal(result.toolCalls[0].observation?.kind, 'content');
  assert.equal(events.filter(event => event.type === 'executor.telemetry.failed').length, 1);
  if (kind === 'executor.usage') assert.equal(events.filter(event => event.type === kind).length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_TELEMETRY_STORAGE/);
});

for (const cancel of [false, true]) test(`pending optional usage persistence ${cancel ? 'does not disable user cancellation' : 'cannot time out a completed evaluation'}`, async t => {
  const data = await fixture(t), controller = new AbortController();
  data.request.profile = { ...profile, timeoutMs: 75 };
  const started = performance.now();
  const call = invokePi({ ...data, signal: controller.signal, streamFn: artifactStream({ mode: 'no-tools' }), onEvent: event => {
    if (event.type !== 'executor.usage') return;
    if (cancel) setTimeout(() => controller.abort(), 10);
    return new Promise<void>(() => {});
  } });
  if (cancel) await assert.rejects(call, { code: 'ABORTED' });
  else assert.equal(((await call).final as { verdict: string }).verdict, 'GREEN');
  assert.ok(performance.now() - started < 1500);
});


test('optional diagnostic failures never replace a real Provider result error', async t => {
  const data = await fixture(t);
  await assert.rejects(invokePi({ ...data, streamFn: artifactStream({ mode: 'malformed' }), onEvent: event => {
    if (event.type === 'executor.usage' || event.type === 'executor.telemetry.failed') throw new Error('PRIVATE_STORAGE_FAILURE');
  } }), error => { assert.equal((error as { code: string }).code, 'PROVIDER_RESULT_INVALID'); assert.doesNotMatch(String(error), /PRIVATE_STORAGE_FAILURE/); return true; });
});

for (const [name, initial, category] of [
  ['single JSON fence', '```json\n' + JSON.stringify(verdict) + '\n```', 'wrapped_json'],
  ['prose around JSON', 'PRIVATE_PROSE ' + JSON.stringify(verdict) + ' PRIVATE_TRAILER', 'wrapped_json'],
  ['adjacent prose', 'PRIVATE_PROSE' + JSON.stringify(verdict) + 'PRIVATE_TRAILER', 'wrapped_json'],
  ['unmatched surrounding bracket', '[format note: ' + JSON.stringify(verdict), 'wrapped_json'],
  ['numeric bracketed prose', '[1: result follows\n' + JSON.stringify(verdict), 'wrapped_json'],
  ['literal bracketed prose', '[true: result follows\n' + JSON.stringify(verdict), 'wrapped_json'],
  ['wrapped scalar after unmatched bracket', 'Result [\"ready\"', 'wrapped_json'],
  ['schema mismatch', JSON.stringify({ verdict: 'PRIVATE_VALUE', evidence: [42], PRIVATE_KEY: 'PRIVATE_VALUE' }), 'schema_mismatch'],
  ['empty text', '', 'empty'],
  ['whitespace only', ' \r\n\t', 'empty'],
  ['non JSON', 'PRIVATE_NON_JSON', 'not_json'],
  ['truncated object key', '{"verdict":', 'not_json'],
  ['truncated object value', '{"verdict":"GREEN"', 'not_json'],
  ['truncated number exponent', '{"value":1e', 'not_json'],
  ['truncated quoted value', '{"value":"unfinished', 'not_json'],
  ['truncated array', '["ready"', 'not_json'],
  ['truncated array with nested object', '[{"ready":true}', 'not_json'],
  ['UTF-8 size limit', 'é'.repeat(524_289), 'over_size'],
] as const) test(`Pi repairs ${name} exactly once in the same context without tools or new evidence`, async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
  const repaired = { ...verdict, verdict: 'RED', summary: 'The model keeps its own verdict.' };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage(initial), fauxAssistantMessage(JSON.stringify(repaired)),
  ]);
  let calls = 0;
  const result = await invokePi({ ...data, onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
    calls++;
    if (calls === 3) {
      assert.deepEqual(context.tools, []); assert.equal(options?.toolChoice, 'none');
      assert.equal(model.id, profile.model); assert.equal(options?.reasoning, profile.reasoning);
      assert.equal(context.messages.filter(message => message.role === 'toolResult').length, 1);
      const previous = context.messages.at(-2)!;
      assert.equal(previous.role, 'assistant');
      if (previous.role === 'assistant') assert.deepEqual(previous.content, [{ type: 'text', text: initial }]);
      const prompt = context.messages.at(-1)!;
      assert.equal(prompt.role, 'user');
      const text = typeof prompt.content === 'string' ? prompt.content : JSON.stringify(prompt.content);
      assert.match(text, new RegExp(`Your final response did not match the required schema: ${category}`));
      assert.match(text, /Return only one JSON value matching the schema\./);
      assert.doesNotMatch(text, /PRIVATE_|GREEN|RED/);
      if (category === 'schema_mismatch') {
        assert.match(text, /#\/properties\/verdict/); assert.match(text, /enum/);
        assert.match(text, /#\/properties\/evidence\/items/);
        assert.doesNotMatch(text, /instancePath|params|allowedValues/);
      }
    }
    return faux.provider.streamSimple(model, context, options);
  } });
  assert.equal(calls, 3); assert.deepEqual(result.final, repaired); assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(events.filter(event => event.type.startsWith('executor.final.')), [
    { type: 'executor.final.invalid', attempt: 'initial', category },
    { type: 'executor.final.repair', outcome: 'started' },
    { type: 'executor.final.repair', outcome: 'succeeded' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_|Inspection complete/);
});

for (const [text, category] of [
  [JSON.stringify({ verdict: 'PRIVATE_VALUE', PRIVATE_KEY: 1 }), 'schema_mismatch'],
  ['', 'empty'], ['PRIVATE_PROSE', 'not_json'],
  ['```json\n' + JSON.stringify(verdict) + '\n```', 'wrapped_json'],
  ['x'.repeat(1_048_577), 'over_size'],
] as const) test(`Pi fails a second ${category} final response with bounded content-free diagnostics`, async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
  faux.setResponses([fauxAssistantMessage('{}'), fauxAssistantMessage(text)]);
  let calls = 0;
  await assert.rejects(invokePi({ ...data, onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
    calls++; return faux.provider.streamSimple(model, context, options);
  } }), error => {
    assert.equal((error as { code: string }).code, 'PROVIDER_RESULT_INVALID');
    assert.match(String(error), new RegExp(`after one format repair: ${category}`));
    assert.doesNotMatch(String(error), /PRIVATE_/); assert.ok(String(error).length < 2000);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(events.filter(event => event.type === 'executor.final.invalid').map(event => [event.attempt, event.category]), [['initial', 'schema_mismatch'], ['repair', category]]);
  assert.equal(events.filter(event => event.type === 'executor.final.repair').at(-1)?.outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('a repair tool call cannot invoke tools, supply evidence or trigger another model turn', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
  faux.setResponses([fauxAssistantMessage('{}'), fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' })]);
  let calls = 0;
  await assert.rejects(invokePi({ ...data, onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
    calls++; return faux.provider.streamSimple(model, context, options);
  } }), { code: 'PROVIDER_RESULT_INVALID' });
  assert.equal(calls, 2); assert.equal(events.some(event => event.type === 'artifact.tool.called'), false);
  assert.equal(events.filter(event => event.type === 'executor.final.repair').at(-1)?.outcome, 'failed');
});

for (const cancel of [false, true]) test(`repair respects ${cancel ? 'external cancellation' : 'the original execution deadline'}`, async t => {
  const data = await fixture(t), controller = new AbortController(), events: ExecutionEvent[] = [];
  const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
  faux.setResponses([async () => { await new Promise(resolve => setTimeout(resolve, 120)); return fauxAssistantMessage('{}'); }]);
  let calls = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let repairStarted = 0;
  try {
    await assert.rejects(invokePi({ ...data, request: { ...data.request, profile: { ...profile, timeoutMs: cancel ? 5_000 : 250 } }, signal: controller.signal,
      onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
        calls++;
        if (calls === 2) {
          repairStarted = performance.now();
          if (cancel) timer = setTimeout(() => controller.abort(), 20);
          faux.appendResponses([async () => {
            await new Promise<void>((_resolve, reject) => {
              if (options?.signal?.aborted) reject(new Error('aborted'));
              else options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
            return fauxAssistantMessage(JSON.stringify(verdict));
          }]);
        }
        return faux.provider.streamSimple(model, context, options);
      },
    }), { code: cancel ? 'ABORTED' : 'PROVIDER_TIMEOUT' });
  } finally { clearTimeout(timer); }
  assert.equal(calls, 2); assert.ok(performance.now() - repairStarted < (cancel ? 1000 : 220), 'Repair must not receive a fresh execution deadline');
  assert.equal(events.filter(event => event.type === 'executor.final.repair').at(-1)?.outcome, 'failed');
});

test('repair checks exact response identity and preserves credential-safe provider errors', async t => {
  for (const mismatch of [false, true]) {
    const data = await fixture(t), events: ExecutionEvent[] = [];
    let calls = 0;
    const streamFn: StreamFn = model => {
      calls++;
      const message = { ...fauxAssistantMessage(calls === 1 ? '{}' : JSON.stringify(verdict), calls === 2 && !mismatch ? { stopReason: 'error', errorMessage: '401 PRIVATE_TOKEN' } : {}), provider: model.provider, model: calls === 2 && mismatch ? 'unrequested' : model.id, api: model.api };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason as 'stop', message }); stream.end(message);
      return stream;
    };
    await assert.rejects(invokePi({ ...data, streamFn, onEvent: event => { events.push(event); } }), error => {
      assert.equal((error as { code: string }).code, mismatch ? 'PROVIDER_IDENTITY_MISMATCH' : 'AUTHENTICATION_FAILED');
      assert.doesNotMatch(String(error), /PRIVATE_/); return true;
    });
    assert.equal(calls, 2); assert.equal(events.filter(event => event.type === 'executor.final.repair').at(-1)?.outcome, 'failed');
  }
});

test('repair schema diagnostics stay bounded and never include response-derived keys or values', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [], prompts: string[] = [];
  const properties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, { type: 'string' }]));
  const invalid = Object.fromEntries(Object.keys(properties).map(key => [key, { PRIVATE_KEY: 'PRIVATE_VALUE' }]));
  invalid.PRIVATE_RESPONSE_KEY = { PRIVATE_KEY: 'PRIVATE_VALUE' };
  const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
  faux.setResponses([fauxAssistantMessage(JSON.stringify(invalid)), fauxAssistantMessage(JSON.stringify(invalid))]);
  await assert.rejects(invokePi({ ...data, schema: { type: 'object', properties, additionalProperties: false }, onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
    const last = context.messages.at(-1)!;
    if (last.role === 'user') prompts.push(typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    return faux.provider.streamSimple(model, context, options);
  } }), error => {
    const message = String(error);
    assert.match(message, /schema_mismatch/); assert.doesNotMatch(message, /PRIVATE_/);
    assert.equal((message.match(/schemaPath/g) ?? []).length, 8); assert.ok(message.length < 2000);
    return true;
  });
  assert.equal(prompts.length, 2); assert.equal((prompts[1].match(/schemaPath/g) ?? []).length, 8);
  assert.doesNotMatch(prompts[1] + JSON.stringify(events), /PRIVATE_/);
});

test('a JSON response at exactly the UTF-8 size limit needs no repair', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const text = JSON.stringify({ ...verdict, summary: '' });
  const final = { ...verdict, summary: 'x'.repeat(1_048_576 - Buffer.byteLength(text)) };
  const response = JSON.stringify(final); assert.equal(Buffer.byteLength(response), 1_048_576);
  let calls = 0;
  const streamFn: StreamFn = model => {
    calls++;
    const message = { ...fauxAssistantMessage(response), provider: model.provider, model: model.id, api: model.api };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  };
  assert.deepEqual((await invokePi({ ...data, streamFn, onEvent: event => { events.push(event); } })).final, final);
  assert.equal(calls, 1); assert.equal(events.some(event => event.type.startsWith('executor.final.')), false);
});

test('unavailable final-result telemetry does not prevent a valid repair or leak sink errors', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const faux = fauxProvider({ provider: profile.provider, api: validatePiProfile(profile).api });
  faux.setResponses([fauxAssistantMessage('{}'), fauxAssistantMessage(JSON.stringify(verdict))]);
  const result = await invokePi({ ...data, streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options), onEvent: event => {
    if (event.type.startsWith('executor.final.')) throw new Error('PRIVATE_SINK_ERROR');
    events.push(event);
  } });
  assert.deepEqual(result.final, verdict);
  assert.equal(events.filter(event => event.type === 'executor.telemetry.failed').length, 1);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
});

test('Anthropic repair preserves historical tool definitions on the wire but disables selection and execution', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const anthropic = { ...profile, provider: 'anthropic', model: 'claude-haiku-4-5', reasoning: 'high' };
  const faux = fauxProvider({ provider: anthropic.provider, api: validatePiProfile(anthropic).api });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('```json\n' + JSON.stringify(verdict) + '\n```'),
    fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' }),
  ]);
  let calls = 0, payloadCheck: Promise<void> | undefined;
  await assert.rejects(invokePi({ ...data, request: { ...data.request, profile: anthropic }, onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
    calls++;
    if (calls === 3) {
      assert.equal(options?.toolChoice, 'none');
      assert.deepEqual(context.tools?.map(tool => tool.name), ['read_spec']);
      assert.equal(context.messages.filter(message => message.role === 'toolResult').length, 1);
      assert.ok(hasApi(model, 'anthropic-messages'));
      payloadCheck = (async () => {
        let captured = false;
        const result = await streamAnthropic(model, context, { ...options, apiKey: 'test-key', onPayload(value) {
          captured = true;
          const payload = value as { tools?: { name: string }[]; tool_choice?: { type: string }; messages?: unknown[] };
          assert.deepEqual(payload.tools?.map(tool => tool.name), ['read_spec']);
          assert.deepEqual(payload.tool_choice, { type: 'none' });
          assert.match(JSON.stringify(payload.messages), /tool_use/); assert.match(JSON.stringify(payload.messages), /tool_result/);
          throw new Error('TEST_STOP_BEFORE_NETWORK');
        } }).result();
        assert.equal(captured, true); assert.match(result.errorMessage ?? '', /TEST_STOP_BEFORE_NETWORK/);
      })();
    }
    return faux.provider.streamSimple(model, context, options);
  } }), { code: 'PROVIDER_RESULT_INVALID' });
  await payloadCheck;
  assert.equal(calls, 3); assert.equal(events.filter(event => event.type === 'artifact.tool.called').length, 1);
});

test('large invalid arrays stop schema diagnostic traversal after the error budget', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const text = JSON.stringify({ ...verdict, evidence: Array(400_000).fill(0) });
  assert.ok(Buffer.byteLength(text) < 1_048_576);
  let calls = 0, repairPrompt = '';
  const result = await invokePi({ ...data, onEvent: event => { events.push(event); }, streamFn: (model, context) => {
    calls++;
    if (calls === 2) repairPrompt = JSON.stringify(context.messages.at(-1));
    const message = { ...fauxAssistantMessage(calls === 1 ? text : JSON.stringify(verdict)), provider: model.provider, model: model.id, api: model.api };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  } });
  assert.deepEqual(result.final, verdict); assert.equal(calls, 2);
  assert.match(repairPrompt, /schema_mismatch/);
  assert.equal((repairPrompt.match(/schemaPath/g) ?? []).length, 0);
  assert.equal(events.filter(event => event.type === 'executor.final.repair').at(-1)?.outcome, 'succeeded');
});

test('Bedrock repair retains the wire tool configuration required by its history without executable tools', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  const bedrock = { ...profile, provider: 'amazon-bedrock', model: 'amazon.nova-lite-v1:0', reasoning: 'off' };
  const faux = fauxProvider({ provider: bedrock.provider, api: validatePiProfile(bedrock).api });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' }), fauxAssistantMessage('{}'),
    fauxAssistantMessage([fauxToolCall('read_spec', {})], { stopReason: 'toolUse' }),
  ]);
  let calls = 0, payloadCheck: Promise<void> | undefined;
  await assert.rejects(invokePi({ ...data, request: { ...data.request, profile: bedrock }, onEvent: event => { events.push(event); }, streamFn: (model, context, options) => {
    calls++;
    if (calls === 3) {
      assert.deepEqual(context.tools?.map(tool => tool.name), ['read_spec']); assert.equal(options?.toolChoice, 'auto');
      assert.ok(hasApi(model, 'bedrock-converse-stream'));
      payloadCheck = (async () => {
        let captured = false;
        const result = await streamBedrock(model, context, { ...options, apiKey: 'test-key', env: { AWS_REGION: 'us-east-1' }, onPayload(value) {
          captured = true;
          const payload = value as { toolConfig?: { tools?: { toolSpec?: { name?: string } }[] }; messages?: unknown[] };
          assert.deepEqual(payload.toolConfig?.tools?.map(tool => tool.toolSpec?.name), ['read_spec']);
          assert.match(JSON.stringify(payload.messages), /toolUse/); assert.match(JSON.stringify(payload.messages), /toolResult/);
          throw new Error('TEST_STOP_BEFORE_NETWORK');
        } }).result();
        assert.equal(captured, true); assert.match(result.errorMessage ?? '', /TEST_STOP_BEFORE_NETWORK/);
      })();
    }
    return faux.provider.streamSimple(model, context, options);
  } }), { code: 'PROVIDER_RESULT_INVALID' });
  await payloadCheck; assert.equal(calls, 3); assert.equal(events.filter(event => event.type === 'artifact.tool.called').length, 1);
});

test('composed final schemas use category-only diagnostics rather than buffering nested errors', async t => {
  const data = await fixture(t), prompts: string[] = [];
  const text = JSON.stringify(Array(400_000).fill(0));
  let calls = 0;
  const result = await invokePi({ ...data, schema: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'boolean' }] }, streamFn: (model, context) => {
    calls++; if (calls === 2) prompts.push(JSON.stringify(context.messages.at(-1)));
    const message = { ...fauxAssistantMessage(calls === 1 ? text : 'true'), provider: model.provider, model: model.id, api: model.api };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  } });
  assert.equal(result.final, true); assert.equal(calls, 2);
  assert.match(prompts[0], /schema_mismatch/); assert.doesNotMatch(prompts[0], /schemaPath|instancePath/);
});

test('many unexpected object keys receive category-only diagnostics without property-name buffers', async t => {
  const data = await fixture(t);
  const invalid = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`PRIVATE_KEY_${index}`, 0]));
  let calls = 0, prompt = '';
  const result = await invokePi({ ...data, streamFn: (model, context) => {
    calls++; if (calls === 2) prompt = JSON.stringify(context.messages.at(-1));
    const message = { ...fauxAssistantMessage(JSON.stringify(calls === 1 ? invalid : verdict)), provider: model.provider, model: model.id, api: model.api };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  } });
  assert.deepEqual(result.final, verdict); assert.equal(calls, 2);
  assert.match(prompt, /schema_mismatch/); assert.doesNotMatch(prompt, /schemaPath|PRIVATE_KEY/);
});
