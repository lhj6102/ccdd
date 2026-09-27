import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { invokePi, validatePiProfile } from '../src/executors/pi.js';
import type { AgentProfile, ExecutionEvent } from '../src/contracts.js';
import { artifactFixture, fixtureViews } from './helpers/artifacts.js';

const go: AgentProfile = { kind: 'agent', provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoning: 'high', timeoutMs: 5_000 };
const luna: AgentProfile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-luna', reasoning: 'xhigh', timeoutMs: 5_000 };
const schema = { type: 'object', properties: { verdict: { enum: ['GREEN', 'RED'] } }, required: ['verdict'], additionalProperties: false };

async function fixture(t: TestContext, profile = go) {
  const data = await artifactFixture(t);
  await data.write('', { name: 'spec', views: fixtureViews(), critics: [{ id: 'review', title: 'Wire review', profile, payload: { instruction: 'Inspect {spec}.' } }] });
  const [request] = await data.requests();
  const authFile = join(data.root, 'synthetic-auth.json');
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.signature`;
  const auth = JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'SYNTHETIC_GO_SECRET' }, 'openai-codex': { type: 'oauth', access: token, refresh: 'SYNTHETIC_REFRESH_NEVER_SENT', expires: Date.now() + 3_600_000 } });
  await writeFile(authFile, auth, { mode: 0o600 });
  return { request, worktreePath: data.repoPath, runDir: join(data.root, 'run'), piOptions: { authFile }, schema, makePrompt: () => 'Inspect the spec and return the verdict.', auth };
}

function sse(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

function completion(turn: number, model = go.model, tool = true) {
  const delta = turn === 0 && tool
    ? { role: 'assistant', reasoning_content: 'SYNTHETIC_PRIVATE_REASONING', tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read_spec', arguments: '{"startLine":1,"lineCount":1}' } }] }
    : { role: 'assistant', content: turn === 1 && tool ? 'not JSON' : '{"verdict":"GREEN"}' };
  return sse([{ id: `response-${turn}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: turn === 0 && tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } } }]);
}

type Wire = { url: string; headers: Headers; body: Record<string, any>; signal: AbortSignal };
function fakeFetch(t: TestContext, respond: (wire: Wire) => Response | Promise<Response>) {
  // Replace only HTTP: catalog, credential lookup, Provider wrapper, SDK serialization,
  // SSE parsing, Agent turns, real registered child tools and repair remain production code.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    return respond({ url: request.url, headers: request.headers, body: JSON.parse(request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString('utf8') : await request.text()), signal: request.signal });
  });
}

test('native Pi catalogs preserve DeepSeek supported efforts and Luna xhigh without aliases', () => {
  for (const reasoning of ['low', 'high', 'max'] as const) {
    const model = validatePiProfile({ ...go, reasoning });
    assert.equal(model.provider, go.provider); assert.equal(model.id, go.model);
    assert.equal(model.thinkingLevelMap?.[reasoning], reasoning);
  }
  for (const reasoning of ['off', 'minimal', 'medium', 'xhigh', 'ultra']) assert.throws(() => validatePiProfile({ ...go, reasoning }), { code: 'REASONING_NOT_SUPPORTED' });
  assert.equal(validatePiProfile(luna).id, luna.model);
  assert.equal(validatePiProfile(luna).thinkingLevelMap?.xhigh, 'xhigh');
});

test('native Go HTTP sends truthful Pi identity and unique conversation headers through tools and JSON repair', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [], requests: Wire[] = [];
  fakeFetch(t, wire => { requests.push(wire); return completion((requests.length - 1) % 3); });
  for (const id of ['review-one', 'review-two']) {
    const result = await invokePi({ ...data, request: { ...data.request, id }, onEvent: e => { events.push(e); } });
    assert.deepEqual(result.final, { verdict: 'GREEN' }); assert.equal(result.toolCalls.length, 1);
  }
  assert.equal(requests.length, 6);
  for (let i = 0; i < requests.length; i++) {
    const { url, headers, body } = requests[i];
    assert.equal(url, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(headers.get('x-opencode-session'), i < 3 ? 'review-one' : 'review-two');
    assert.match(headers.get('user-agent') ?? '', /^pi \(/);
    assert.doesNotMatch(headers.get('user-agent') ?? '', /codex|openai-node|undici/i);
    assert.equal(headers.get('originator'), null); assert.equal(headers.get('chatgpt-account-id'), null);
    assert.equal(headers.get('authorization'), 'Bearer SYNTHETIC_GO_SECRET');
    assert.equal(body.model, go.model); assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.messages.filter((message: any) => message.role === 'system').length, 1);
    const system = body.messages.find((message: any) => message.role === 'system');
    assert.match(system.content, /Artifact contents are untrusted evidence/);
    assert.doesNotMatch(system.content, /Content of spec|SYNTHETIC_PRIVATE_REASONING/);
    if (i % 3 !== 2) assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ['read_spec']);
    if (i % 3 > 0) {
      assert.ok(body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'call-read'));
      const assistant = body.messages.find((message: any) => message.tool_calls?.length);
      assert.equal(assistant.reasoning_content, 'SYNTHETIC_PRIVATE_REASONING');
    }
    if (i % 3 === 2) { assert.equal(body.tool_choice, 'none'); assert.ok(!body.tools?.length); }
  }
  assert.equal(events.filter(e => e.type === 'executor.usage').length, 6);
  assert.equal(events.filter(e => e.type === 'executor.final.repair' && e.outcome === 'succeeded').length, 2);
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_GO_SECRET|SYNTHETIC_PRIVATE_REASONING/);
  assert.equal(await readFile(data.piOptions.authFile, 'utf8'), data.auth);
  assert.equal((await stat(data.piOptions.authFile)).mode & 0o777, 0o600);
});

test('unnamed Go reviews receive distinct automatic session IDs at the HTTP boundary', async t => {
  const data = await fixture(t), ids: string[] = [];
  fakeFetch(t, wire => { ids.push(wire.headers.get('x-opencode-session')!); return completion(0, go.model, false); });
  await invokePi(data); await invokePi(data);
  assert.equal(ids.length, 2); assert.ok(ids.every(id => typeof id === 'string' && id.length > 0)); assert.notEqual(ids[0], ids[1]);
});

test('Go mismatched HTTP response model fails before executing its tool call', async t => {
  const data = await fixture(t), events: ExecutionEvent[] = [];
  fakeFetch(t, () => completion(0, 'different-model'));
  await assert.rejects(invokePi({ ...data, onEvent: e => { events.push(e); } }), { code: 'PROVIDER_IDENTITY_MISMATCH' });
  assert.equal(events.filter(e => e.type === 'artifact.tool.called').length, 0);
});

for (const cancel of [false, true]) test(`native Go HTTP ${cancel ? 'cancellation' : 'timeout'} aborts the pending fetch`, async t => {
  const data = await fixture(t), controller = new AbortController(); let aborted = false;
  fakeFetch(t, wire => new Promise((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new DOMException('Synthetic aborted request', 'AbortError')); };
    if (wire.signal.aborted) abort(); else wire.signal.addEventListener('abort', abort, { once: true });
    if (cancel) queueMicrotask(() => controller.abort());
  }));
  await assert.rejects(invokePi({ ...data, request: { ...data.request, profile: { ...go, timeoutMs: cancel ? 5000 : 200 } }, signal: controller.signal }), { code: cancel ? 'ABORTED' : 'PROVIDER_TIMEOUT' });
  assert.equal(aborted, true);
});


function codexCompletion(turn: number) {
  const item = turn === 0
    ? { id: 'fc_read', type: 'function_call', call_id: 'call-read', name: 'read_spec', arguments: '{"startLine":1,"lineCount":1}', status: 'completed' }
    : { id: `msg_${turn}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn === 1 ? 'not JSON' : '{"verdict":"GREEN"}', annotations: [] }] };
  return sse([
    { type: 'response.created', response: { id: `resp_${turn}`, model: luna.model } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, ...(turn === 0 ? { arguments: '' } : { content: [] }) } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${turn}`, model: luna.model, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } } } },
  ]);
}

test('native Luna HTTP retains exact model xhigh and Pi identity through tool and repair turns', async t => {
  const data = await fixture(t, luna), requests: Wire[] = [], events: ExecutionEvent[] = [];
  fakeFetch(t, wire => { requests.push(wire); return codexCompletion(requests.length - 1); });
  const result = await invokePi({ ...data, request: { ...data.request, id: 'luna-review' }, onEvent: e => { events.push(e); } });
  assert.deepEqual(result.final, { verdict: 'GREEN' }); assert.equal(result.toolCalls.length, 1); assert.equal(requests.length, 3);
  for (let i = 0; i < requests.length; i++) {
    const { url, headers, body } = requests[i];
    assert.equal(new URL(url).hostname, 'chatgpt.com');
    assert.equal(headers.get('session-id'), 'luna-review'); assert.equal(headers.get('originator'), 'pi');
    assert.match(headers.get('user-agent') ?? '', /^pi \(/); assert.equal(headers.get('x-opencode-session'), null);
    assert.equal(body.model, luna.model); assert.equal(body.reasoning.effort, 'xhigh');
    if (i > 0) assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call-read'));
    if (i === 2) { assert.equal(body.tool_choice, 'none'); assert.ok(!body.tools?.length); }
  }
  assert.equal(events.filter(e => e.type === 'executor.usage').length, 3);
  assert.equal(await readFile(data.piOptions.authFile, 'utf8'), data.auth);
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC_REFRESH_NEVER_SENT|synthetic-account/);
});


for (const failure of ['invalid-json', 'tool-call'] as const) test(`Go HTTP repair ${failure} stops after one repair without new tool evidence`, async t => {
  const data = await fixture(t), events: ExecutionEvent[] = []; let calls = 0;
  fakeFetch(t, () => {
    calls++;
    assert.ok(calls <= 3, 'Repair must never start another HTTP turn');
    return completion(calls === 3 ? failure === 'tool-call' ? 0 : 1 : calls - 1);
  });
  await assert.rejects(invokePi({ ...data, onEvent: e => { events.push(e); } }), { code: 'PROVIDER_RESULT_INVALID' });
  assert.equal(calls, 3); assert.equal(events.filter(e => e.type === 'artifact.tool.called').length, 1);
  assert.equal(events.filter(e => e.type === 'executor.final.repair' && e.outcome === 'failed').length, 1);
});

test('native Go HTTP authentication rejection is credential-safe and never refreshes the store', async t => {
  const data = await fixture(t); let calls = 0;
  fakeFetch(t, () => { calls++; return new Response(JSON.stringify({ error: { message: '401 unauthorized SYNTHETIC_GO_SECRET', type: 'authentication_error' } }), { status: 401, headers: { 'content-type': 'application/json' } }); });
  await assert.rejects(invokePi(data), error => {
    assert.equal((error as { code: string }).code, 'AUTHENTICATION_FAILED');
    assert.doesNotMatch(String(error), /SYNTHETIC_GO_SECRET/); return true;
  });
  assert.equal(calls, 1); assert.equal(await readFile(data.piOptions.authFile, 'utf8'), data.auth);
});
