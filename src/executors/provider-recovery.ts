import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type ProviderResponse } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export type ProviderFailureKind = 'authentication' | 'quota' | 'transient' | 'permanent' | 'unknown';
export interface ProviderFailure { kind: ProviderFailureKind; code: string; retryAfterMs?: number }
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};
/** Only classification leaves this boundary; Provider bodies and headers are not telemetry. */
export function classifyProviderFailure(value: unknown, response?: ProviderResponse, now = Date.now()): ProviderFailure {
  const input = record(value), body = record(input.error);
  const message = String(input.errorMessage ?? input.message ?? (typeof value === 'string' ? value : '')).slice(0, 8192);
  const code = String(body.code ?? input.code ?? '').slice(0, 128);
  const text = `${code} ${message}`;
  const status = response?.status ?? input.status ?? input.statusCode;
  if (status === 401 || /AUTHENTICATION|\b401\b|unauthori[sz]ed|invalid_api_key|token_expired|credential/i.test(text)) return { kind: 'authentication', code: 'AUTHENTICATION_FAILED' };
  if (/insufficient_quota|QUOTA_EXHAUSTED|quota|billing[_ ](?:limit|hard)|credits? (?:exhausted|depleted)|usage limit/i.test(text)) return { kind: 'quota', code: 'QUOTA_EXHAUSTED' };
  if (status === 403 || /\b403\b|forbidden|access_denied|model_not_found|invalid_request|unsupported|not supported|certificate|TLS/i.test(text)) return { kind: 'permanent', code: 'PROVIDER_REQUEST_REJECTED' };
  const transient = [408, 425, 429, 500, 502, 503, 504].includes(Number(status)) || /\b(?:408|425|429|500|502|503|504)\b|rate[_ -]?limit|overloaded|temporarily unavailable|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network error/i.test(text);
  if (transient) {
    const headers = response?.headers ?? record(input.headers);
    const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    let retryAfterMs: number | undefined;
    if (typeof raw === 'string') {
      const seconds = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
      const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
      if (Number.isFinite(milliseconds) && milliseconds >= 0) retryAfterMs = Math.min(milliseconds, 2_147_483_647);
    }
    return { kind: 'transient', code: Number(status) === 429 || /rate[_ -]?limit|\b429\b/i.test(text) ? 'RATE_LIMITED' : 'PROVIDER_TRANSIENT_FAILURE', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (Number(status) >= 400 && Number(status) < 500) return { kind: 'permanent', code: 'PROVIDER_REQUEST_REJECTED' };
  return { kind: 'unknown', code: 'PROVIDER_EXECUTION_FAILED' };
}

const unreported = new WeakSet<object>();
export const providerUsageUnreported = (message: object) => unreported.has(message);
export interface ProviderRetryEvent { attempt: number; delayMs: number; code: string; usageState: 'unreported' }
export interface RecoveryOptions {
  signal: AbortSignal;
  /** One monotonic deadline for the entire review, including format repair. */
  deadline: number;
  onRetry?: (event: ProviderRetryEvent) => void;
  /** Internal test controls, not per-project retry policy. */
  maxAttempts?: number;
  initialDelayMs?: number;
}

/**
 * Retry a rejected/failed turn before any content is delivered. Never replay a
 * completed turn, tools, partial output or reported usage. A whole review is
 * not restarted. This does not claim exactly-once remote execution or billing.
 */
export function recoveringProviderStream(invoke: StreamFn, recovery: RecoveryOptions): StreamFn {
  const maxAttempts = recovery.maxAttempts ?? 3, initialDelayMs = recovery.initialDelayMs ?? 250;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 || !Number.isFinite(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 10000) throw new Error('Invalid internal Provider recovery limits.');
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const signal = options?.signal ? AbortSignal.any([options.signal, recovery.signal]) : recovery.signal;
    const failureMessage = (code: string, aborted = false): AssistantMessage => {
      const message: AssistantMessage = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: aborted ? 'aborted' : 'error', errorMessage: code,
        // Pi requires this wire shape, but these synthetic placeholders are not
        // Provider usage. The executor must exclude them from persisted usage.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      unreported.add(message); return message;
    };
    const finishError = (message: AssistantMessage) => { output.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message }); output.end(message); };
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        if (performance.now() >= recovery.deadline) { finishError(failureMessage('PROVIDER_TIMEOUT', true)); return; }
        let response: ProviderResponse | undefined, start: Extract<AssistantMessageEvent, { type: 'start' }> | undefined;
        let delivered = false, failed: AssistantMessage | undefined, cause: unknown;
        try {
          const source = await invoke(model, context, { ...options, signal,
            // CCDD bounds retries once, rather than nesting its policy around SDK retries.
            maxRetries: 0,
            onResponse: async (value, selectedModel) => { response = value; await options?.onResponse?.(value, selectedModel); },
          });
          for await (const event of source) {
            signal.throwIfAborted();
            if (event.type === 'start' && !delivered) { start = event; continue; }
            if (event.type === 'error') { failed = event.error; cause = event.error; break; }
            if (start) { output.push(start); start = undefined; }
            delivered = true; output.push(event);
            if (event.type === 'done') { output.end(event.message); return; }
          }
          cause ??= new Error('Provider stream ended without a terminal event.');
        } catch (error) { cause = error; }
        signal.throwIfAborted();
        const classification = classifyProviderFailure(cause, response);
        const used = failed?.usage;
        const hasUsage = !!used && [used.input, used.output, used.cacheRead, used.cacheWrite, used.totalTokens].some(count => Number(count) > 0);
        const hasContent = !!failed?.content.length || !!start?.partial.content.length;
        const retryMs = Math.max(classification.retryAfterMs ?? 0, Math.min(10000, initialDelayMs * 2 ** (attempt - 1)));
        const retry = classification.kind === 'transient' && !delivered && !hasUsage && !hasContent && attempt < maxAttempts && performance.now() + retryMs < recovery.deadline;
        if (!retry) {
          if (start) output.push(start);
          const terminal = failed ?? failureMessage(classification.code);
          if (!hasUsage && !delivered) unreported.add(terminal);
          finishError(terminal); return;
        }
        // Never let an optional observer become an unhandled stream failure.
        try { recovery.onRetry?.({ attempt, delayMs: retryMs, code: classification.code, usageState: 'unreported' }); } catch {}
        await delay(retryMs, undefined, { signal });
      }
    })().catch(() => finishError(failureMessage(signal.aborted ? 'ABORTED' : 'PROVIDER_EXECUTION_FAILED', signal.aborted)));
    return output;
  };
}
