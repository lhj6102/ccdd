import type { ReviewResult, ReviewToolCall } from './contracts.js';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function storedObservation(value: unknown, isError = false): ReviewToolCall['observation'] {
  if (!object(value) || typeof value.artifactId !== 'string' || typeof value.operation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.operation)) return undefined;
  const observation: NonNullable<ReviewToolCall['observation']> = { artifactId: value.artifactId.slice(0, 64), operation: value.operation };
  if (isError) return observation;
  if (value.kind === 'content' || value.kind === 'empty') observation.kind = value.kind;
  if (typeof value.detail === 'string') observation.detail = value.detail.slice(0, 2000);
  for (const key of ['startLine', 'endLine', 'lineCount', 'totalLines'] as const) {
    const number = value[key];
    if (number === null || (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)) observation[key] = number;
  }
  return observation;
}

function measureReviewResult(value: unknown): { result: ReviewResult; length: number } {
  if (!object(value) || (value.verdict !== 'GREEN' && value.verdict !== 'RED') || typeof value.summary !== 'string' || !value.summary.trim() ||
      !Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string')) {
    throw new Error('Review result requires GREEN/RED verdict, a summary, and string evidence[].');
  }
  const result: ReviewResult = { verdict: value.verdict, summary: value.summary.slice(0, 12_000), evidence: (value.evidence as string[]).slice(0, 100).map(item => item.slice(0, 4000)) };
  for (const key of ['provider', 'model', 'stdout', 'stderr'] as const) { const field = value[key]; if (typeof field === 'string') result[key] = field.slice(0, 24_000); }
  for (const key of ['durationMs', 'exitCode'] as const) { const field = value[key]; if (typeof field === 'number' && Number.isFinite(field)) result[key] = field; }
  if (Array.isArray(value.toolCalls)) result.toolCalls = value.toolCalls.slice(0, 100).filter((item): item is Record<string, unknown> & { name: string } => object(item) && typeof item.name === 'string').map(item => {
    const call: ReviewToolCall = { name: item.name, ...(item.arguments === undefined ? {} : { arguments: copy(item.arguments) }) };
    const observation = storedObservation(item.observation, item.isError === true);
    if (item.isError === true) call.isError = true;
    if (observation) call.observation = observation;
    return call;
  });
  return { result, length: JSON.stringify(result).length };
}

export function normalizeReviewResult(value: unknown): ReviewResult {
  const measured = measureReviewResult(value);
  assertResultSize(measured.length);
  return measured.result;
}

function assertResultSize(length: number) {
  if (length > 256_000) throw new Error('Review result exceeds the supported size.');
}

/** Cache immutable metadata normalization/serialization across final-response candidates. */
export function createReviewResultSizeCheck(metadata: Pick<ReviewResult, 'provider' | 'model' | 'toolCalls'>) {
  const placeholder = { verdict: 'GREEN', summary: '.', evidence: [] };
  // Measure without rejecting here: even an over-limit size must stay cached.
  const metadataSize = measureReviewResult({ ...placeholder, ...metadata }).length - JSON.stringify(placeholder).length;
  return (value: unknown): ReviewResult => {
    assertResultSize(metadataSize);
    const measured = measureReviewResult(value);
    assertResultSize(measured.length + metadataSize);
    return measured.result;
  };
}
