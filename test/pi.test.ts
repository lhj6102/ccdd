import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, hasApi, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { invokePi, validatePiProfile, type InvokePiOptions, type StreamFn } from '../src/executors/pi.js';
import { assertPiAuthFilesOutsideWorkspace, createPiCredentialStore } from '../src/executors/auth.js';
import type { AgentProfile, ExecutionEvent, ReviewEnvelope } from '../src/contracts.js';
import { artifactStream } from './pi-fixture.js';

const schema = { type: 'object', required: ['verdict', 'summary', 'evidence'], additionalProperties: false, properties: { verdict: { type: 'string', enum: ['GREEN', 'RED'] }, summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } } };
const profile: AgentProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 5_000 };
const verdict = { verdict: 'GREEN', summary: 'Inspection complete', evidence: ['Inspected line 2 of spec.md.'] };

async function fixture(t: TestContext): Promise<InvokePiOptions & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-pi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktreePath = join(dir, 'snapshot');
  await mkdir(worktreePath);
  await writeFile(join(worktreePath, 'spec.md'), '\uccab\uc9f8 \uc904\r\n\ub458\uc9f8 \uc904\r\n\uc14b\uc9f8 \uc904\n');
  const request: ReviewEnvelope = {
    repoId: 'test', criticId: 'spec-why', title: 'Review Spec', snapshotHash: 'a'.repeat(64), target: 'spec', deps: [],
    artifacts: [{ id: 'spec', type: 'markdown', path: 'spec.md' }],
    artifactTypes: { markdown: { viewer: 'text', tools: { read: { description: 'Read content from {artifactName} by line.' } } } },
    payload: { instruction: 'Inspect Spec.' }, profile: { ...profile },
  };
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
    assert.equal(actual.toolCalls[0]?.observation?.lineCount, 1);
    assert.equal(actual.toolCalls[0]?.observation?.startLine, 2);
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
  const path = join(data.worktreePath, 'spec.md');
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
