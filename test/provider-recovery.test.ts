import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { classifyProviderFailure, recoveringProviderStream, providerUsageUnreported, type ProviderRetryEvent } from '../src/executors/provider-recovery.js';
import type { StreamFn } from '../src/executors/pi.js';

const model = builtinModels().getModel('openai-codex', 'gpt-6-astra')!;
const context = normalizeContext({ messages: [] });
function message(errorMessage?: string): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 0,
    stopReason: errorMessage ? 'error' : 'stop', ...(errorMessage ? { errorMessage } : {}),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function stream(final: AssistantMessage, partial = false) {
  const source = createAssistantMessageEventStream();
  source.push({ type: 'start', partial: message() });
  if (partial) source.push({ type: 'text_start', contentIndex: 0, partial: { ...message(), content: [{ type: 'text', text: 'partial' }] } });
  if (final.stopReason === 'error') source.push({ type: 'error', reason: 'error', error: final });
  else source.push({ type: 'done', reason: 'stop', message: final });
  source.end(final); return source;
}
const options = () => ({ signal: new AbortController().signal, deadline: performance.now() + 1000, initialDelayMs: 0 });

test('Provider classification distinguishes authentication, quota, permanent errors and transient rejection', () => {
  for (const value of [{ status: 401 }, 'AUTHENTICATION_EXPIRED', 'invalid_api_key']) assert.equal(classifyProviderFailure(value).kind, 'authentication');
  for (const value of ['429 insufficient_quota', 'QUOTA_EXHAUSTED', 'billing hard limit', 'usage limit reached']) assert.equal(classifyProviderFailure(value).kind, 'quota');
  for (const value of [{ status: 403 }, 'model_not_found', 'TLS certificate invalid', { status: 400 }]) assert.equal(classifyProviderFailure(value).kind, 'permanent');
  for (const value of [{ status: 429 }, { status: 503 }, 'EAI_AGAIN', 'ECONNRESET', 'temporarily unavailable']) assert.equal(classifyProviderFailure(value).kind, 'transient');
  assert.equal(classifyProviderFailure('unrecognized secret').kind, 'unknown');
});

test('Retry-After accepts seconds and dates without persisting response headers', () => {
  assert.equal(classifyProviderFailure('', { status: 429, headers: { 'Retry-After': '2' } }).retryAfterMs, 2000);
  assert.equal(classifyProviderFailure('', { status: 503, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' } }, 1000).retryAfterMs, 2000);
  assert.equal(classifyProviderFailure('', { status: 503, headers: { 'retry-after': 'invalid', authorization: 'secret' } }).retryAfterMs, undefined);
  assert.doesNotMatch(JSON.stringify(classifyProviderFailure('secret', { status: 503, headers: { authorization: 'secret' } })), /secret/);
});

test('transient rejected turns retry internally with unchanged model, context and session', async () => {
  let calls = 0; const events: ProviderRetryEvent[] = [];
  const fn: StreamFn = (selected, input, configured) => {
    assert.equal(selected, model); assert.equal(input, context); assert.equal(configured?.sessionId, 'stable');
    assert.equal(configured?.maxRetries, 0);
    return stream(message(++calls < 3 ? '429 rate limit' : undefined));
  };
  const source = await recoveringProviderStream(fn, { ...options(), onRetry: event => events.push(event) })(model, context, { sessionId: 'stable' });
  const received = []; for await (const event of source) received.push(event.type);
  assert.deepEqual(received, ['start', 'done']); assert.equal(calls, 3);
  assert.deepEqual(events.map(e => [e.attempt, e.code, e.usageState]), [[1, 'RATE_LIMITED', 'unreported'], [2, 'RATE_LIMITED', 'unreported']]);
});

test('auth, quota, permanent and unknown failures are never repeatedly submitted', async () => {
  for (const text of ['401 authentication failed', '429 insufficient_quota', '400 invalid_request', 'unrecognized']) {
    let calls = 0;
    const source = await recoveringProviderStream(() => { calls++; return stream(message(text)); }, options())(model, context);
    assert.equal((await source.result()).stopReason, 'error'); assert.equal(calls, 1);
  }
});

test('partial output and reported usage are not discarded to replay a turn', async () => {
  for (const partial of [false, true]) {
    let calls = 0; const final = message('503 unavailable');
    if (!partial) final.usage.input = final.usage.totalTokens = 10;
    const source = await recoveringProviderStream(() => { calls++; return stream(final, partial); }, options())(model, context);
    assert.equal((await source.result()).stopReason, 'error'); assert.equal(calls, 1);
    assert.equal(providerUsageUnreported(final), false);
  }
});

test('Provider retries have an attempt bound and respect the review deadline and Retry-After', async () => {
  let calls = 0;
  const source = await recoveringProviderStream(() => { calls++; return stream(message('429')); }, options())(model, context);
  await source.result(); assert.equal(calls, 3);
  calls = 0;
  const fn: StreamFn = async (selected, _, configured) => {
    calls++; await configured?.onResponse?.({ status: 429, headers: { 'retry-after': '60' } }, selected);
    return stream(message('429'));
  };
  const limited = await recoveringProviderStream(fn, options())(model, context);
  await limited.result(); assert.equal(calls, 1);
});

test('cancellation interrupts retry backoff and reports no invented Provider usage', async () => {
  const controller = new AbortController(); let calls = 0;
  const source = await recoveringProviderStream(() => { calls++; return stream(message('503')); }, {
    ...options(), signal: controller.signal, initialDelayMs: 500, onRetry: () => controller.abort(),
  })(model, context);
  const final = await source.result(); assert.equal(final.stopReason, 'aborted'); assert.equal(calls, 1);
  assert.equal(providerUsageUnreported(final), true);
});

test('thrown transient transport failure is bounded and observer exceptions cannot hang the stream', async () => {
  let calls = 0;
  const source = await recoveringProviderStream(() => { calls++; throw new Error('ECONNREFUSED'); }, { ...options(), onRetry: () => { throw Error('diagnostic failure'); } })(model, context);
  const final = await source.result(); assert.equal(final.stopReason, 'error'); assert.equal(calls, 3);
  assert.equal(providerUsageUnreported(final), true);
});
