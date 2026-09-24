import { Compile } from 'typebox/compile';
import { ErrorContext, ErrorSchema, Stack } from 'typebox/schema';
import type { TSchema } from '@earendil-works/pi-ai';

export type FinalResultCategory = 'empty' | 'not_json' | 'wrapped_json' | 'schema_mismatch' | 'over_size';
export interface FinalResultDiagnostic { category: FinalResultCategory; issues?: { schemaPath: string; keyword: string }[] }
type Inspection = { valid: true; final: unknown } | { valid: false; diagnostic: FinalResultDiagnostic };
const MAX_BYTES = 1_048_576;

function parses(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Diagnostic detection only: never extract or accept a verdict from surrounding text. */
function containsJson(text: string): boolean {
  const stack: { start: number; char: string }[] = [];
  let quote = -1, escaped = false;
  // Nested complete candidates survive unmatched delimiters in surrounding prose.
  // A total parse budget bounds overlapping malformed candidates to linear work.
  let budget = text.length * 2;
  const candidate = (start: number, end: number) => {
    const length = end - start;
    if (length > budget) return false;
    budget -= length;
    return parses(text.slice(start, end));
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote >= 0) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        if (candidate(quote, index + 1)) return true;
        quote = -1;
      }
    } else if (char === '"') quote = index;
    else if (char === '{' || char === '[') stack.push({ start: index, char });
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if (open?.char === (char === '}' ? '{' : '[') && candidate(open.start, index + 1)) return true;
    } else if (/[tfn0-9-]/.test(char) && (index === 0 || /\s/.test(text[index - 1]))) {
      let end = index;
      while (end < text.length && !/\s/.test(text[end])) end++;
      if (candidate(index, end)) return true;
    }
  }
  return false;
}

/** Composed schemas can buffer errors outside our callback; use category-only diagnostics there. */
function supportsBoundedErrors(schema: unknown): boolean {
  if (typeof schema === 'boolean') return true;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const value = schema as Record<string, unknown>;
  const simple = ['type', 'enum', 'const', 'required', 'additionalProperties', 'properties', 'items', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'description', 'title'];
  if (Object.keys(value).some(key => !simple.includes(key))) return false;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') return false;
  if (value.properties && Object.values(value.properties).some(child => !supportsBoundedErrors(child))) return false;
  return value.items === undefined || supportsBoundedErrors(value.items);
}

/** Avoid TypeBox's keyword-local buffers even for flat objects with many extra keys. */
function smallDiagnosticValue(value: unknown): boolean {
  const pending = [value];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const key in current) {
      if (++entries > 256) return false;
      pending.push((current as Record<string, unknown>)[key]);
    }
  }
  return true;
}

/** Only schema locations/keywords leave the validator; instance paths, params and messages never do. */
export function createFinalResultInspector(schema: Record<string, unknown>): (content: string) => Inspection {
  const validator = Compile(schema as TSchema);
  const boundedErrors = supportsBoundedErrors(schema);
  return content => {
    if (Buffer.byteLength(content) > MAX_BYTES) return { valid: false, diagnostic: { category: 'over_size' } };
    if (!content.trim()) return { valid: false, diagnostic: { category: 'empty' } };
    let final: unknown;
    try { final = JSON.parse(content); }
    catch {
      return { valid: false, diagnostic: { category: containsJson(content) ? 'wrapped_json' : 'not_json' } };
    }
    if (validator.Check(final)) return { valid: true, final };
    if (!boundedErrors || !smallDiagnosticValue(final)) return { valid: false, diagnostic: { category: 'schema_mismatch' } };
    const issues: NonNullable<FinalResultDiagnostic['issues']> = [];
    const exhausted = Symbol('diagnostic budget');
    let errors = 0;
    const context = new ErrorContext(({ schemaPath, keyword }) => {
      if (schemaPath.length <= 160 && keyword.length <= 40 && !/[\x00-\x1f\x7f]/.test(schemaPath) && /^[A-Za-z]+$/.test(keyword) &&
        !issues.some(issue => issue.schemaPath === schemaPath && issue.keyword === keyword)) issues.push({ schemaPath, keyword });
      // Stop actual traversal, not just storage; repeated invalid array items also consume the budget.
      if (++errors === 8) throw exhausted;
    });
    try { ErrorSchema(new Stack({}, schema), context, '#', '', schema, final); }
    catch (error) { if (error !== exhausted) throw error; }
    return { valid: false, diagnostic: { category: 'schema_mismatch', issues } };
  };
}

export function finalResultDescription({ category, issues }: FinalResultDiagnostic): string {
  return category + (issues?.length ? ` ${JSON.stringify(issues)}` : '');
}

/** Broker allowlist: never persist caller-supplied messages, paths or response fields for these events. */
export function finalResultEventData(event: Record<string, unknown>): Record<string, string> | undefined {
  const { attempt, category, outcome } = event;
  if (event.type === 'executor.final.invalid' && typeof attempt === 'string' && ['initial', 'repair'].includes(attempt) &&
    typeof category === 'string' && ['empty', 'not_json', 'wrapped_json', 'schema_mismatch', 'over_size'].includes(category)) {
    return { attempt, category };
  }
  if (event.type === 'executor.final.repair' && typeof outcome === 'string' && ['started', 'succeeded', 'failed'].includes(outcome)) return { outcome };
  return undefined;
}
