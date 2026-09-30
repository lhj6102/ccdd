import { isDeepStrictEqual } from 'node:util';
import { Compile } from 'typebox/compile';
import type { TSchema } from '@earendil-works/pi-ai';

export type FinalResultCategory = 'empty' | 'not_json' | 'wrapped_json' | 'schema_mismatch' | 'over_size' | 'result_check';
/** `messages` carries a Critic result check's own errors into the repair prompt only. */
export interface FinalResultDiagnostic { category: FinalResultCategory; issues?: { schemaPath: string; keyword: string }[]; messages?: string[] }
type Inspection = { valid: true; final: unknown } | { valid: false; diagnostic: FinalResultDiagnostic };
const MAX_BYTES = 1_048_576;

function parses(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Recognize an unfinished JSON container, without mistaking bracketed prose for JSON. */
function isContainerPrefix(text: string): boolean {
  const source = text.trim();
  if (source[0] !== '[' && source[0] !== '{') return false;
  type State = 'value' | 'arrayFirst' | 'arrayNext' | 'objectFirst' | 'key' | 'colon' | 'objectNext' | 'done';
  const states: State[] = ['value'];
  const containers: State[] = ['done'];
  const token = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][+-]?[0-9]*)?|true|false|null|[{}\[\]:,])/y;
  let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) {
      // Only an unfinished token at EOF can extend a syntactically valid prefix.
      const tail = source.slice(offset).trimStart();
      const state = states.at(-1);
      const stringPosition = ['value', 'arrayFirst', 'objectFirst', 'key'].includes(state!);
      if (stringPosition && /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*(?:\\(?:u[0-9a-fA-F]{0,3})?)?$/.test(tail)) return true;
      return (state === 'value' || state === 'arrayFirst') && /^(?:t(?:r(?:u)?)?|f(?:a(?:l(?:s)?)?)?|n(?:u(?:l)?)?|-)$/.test(tail);
    }
    offset = token.lastIndex;
    const word = match[1], state = states.at(-1)!;
    if (state === 'done') return false;
    if (state === 'colon') { if (word !== ':') return false; states[states.length - 1] = 'value'; continue; }
    if (state === 'arrayNext' || state === 'objectNext') {
      if (word === (state === 'arrayNext' ? ']' : '}')) { states.pop(); containers.pop(); continue; }
      if (word !== ',') return false;
      states[states.length - 1] = state === 'arrayNext' ? 'value' : 'key'; continue;
    }
    if (state === 'objectFirst' && word === '}') { states.pop(); containers.pop(); continue; }
    if (state === 'key' || state === 'objectFirst') {
      if (!word.startsWith('"')) return false;
      states[states.length - 1] = 'colon'; continue;
    }
    if (state === 'arrayFirst' && word === ']') { states.pop(); containers.pop(); continue; }
    if (/^[}\]:,]$/.test(word)) return false;
    if (/^[0-9-]/.test(word) && !parses(word)) return offset === source.length;
    // The parent container determines the state after consuming this value.
    const parent = containers.at(-1)!;
    states[states.length - 1] = parent;
    if (word === '[' || word === '{') {
      states.push(word === '[' ? 'arrayFirst' : 'objectFirst');
      containers.push(word === '[' ? 'arrayNext' : 'objectNext');
    }
  }
  return states.length > 1;
}

/** Diagnostic detection only: never extract or accept a verdict from surrounding text. */
function containsJson(text: string): boolean {
  const stack: { start: number; char: string }[] = [];
  const leadingContainer = isContainerPrefix(text);
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
        if ((!stack.length || !leadingContainer) && candidate(quote, index + 1)) return true;
        quote = -1;
      }
    } else if (char === '"') quote = index;
    else if (char === '{' || char === '[') stack.push({ start: index, char });
    else if (char === '}' || char === ']') {
      const open = stack.pop();
      if (open?.char === (char === '}' ? '{' : '[') && (!stack.length || !leadingContainer) && candidate(open.start, index + 1)) return true;
    } else if ((!stack.length || !leadingContainer) && /[tfn0-9-]/.test(char) && (index === 0 || /\s/.test(text[index - 1]))) {
      let end = index;
      while (end < text.length && !/\s/.test(text[end])) end++;
      if (candidate(index, end)) return true;
    }
  }
  return false;
}

type Schema = Record<string, unknown>;
type Issue = { schemaPath: string; keyword: string };
const isSchema = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);
const annotations = new Set(['description', 'title', 'default', 'examples']);
const MAX_ISSUES = 8, MAX_CHECKS = 1024;

/** A keyword checked on its own, with the siblings its meaning depends on; undefined when it constrains nothing. */
function isolatedKeyword(node: Schema, keyword: string): Schema | undefined {
  if (keyword === 'additionalProperties') return { properties: Object.fromEntries(Object.keys(isSchema(node.properties) ? node.properties : {}).map(name => [name, {}])), additionalProperties: node.additionalProperties };
  if (keyword === 'minContains' || keyword === 'maxContains') return node.contains === undefined ? undefined : { contains: node.contains, minContains: keyword === 'minContains' ? node.minContains : 0, ...(keyword === 'maxContains' ? { maxContains: node.maxContains } : {}) };
  if (keyword === 'contains' && node.minContains === 0) return undefined;
  return { [keyword]: node[keyword] };
}

/** The one branch of an anyOf/oneOf whose property const equals the value's, such as a verdict. */
function discriminatedBranch(branches: unknown, value: unknown): number | undefined {
  if (!Array.isArray(branches) || !branches.every(isSchema) || !isSchema(value)) return undefined;
  const constant = (branch: Schema, key: string) => isSchema(branch.properties) && isSchema(branch.properties[key]) && Object.hasOwn(branch.properties[key], 'const') ? [branch.properties[key].const] : undefined;
  for (const key of Object.keys(isSchema(branches[0].properties) ? branches[0].properties : {})) {
    const constants = branches.map(branch => constant(branch, key));
    if (constants.some(entry => entry === undefined)) continue;
    const matches = constants.flatMap((entry, index) => Object.hasOwn(value, key) && isDeepStrictEqual(entry![0], value[key]) ? [index] : []);
    // A const shared by several branches, or matching none, does not discriminate; try the next property.
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

/**
 * Locate failed keywords with boolean checks only, so no validator error list is buffered.
 * GREEN/RED and other const-discriminated branches are followed into the branch the value
 * names. Only schema locations and keywords are reported, never instance paths or values.
 */
function locateFailures(root: Schema, value: unknown): Issue[] {
  const issues: Issue[] = [], validators = new WeakMap<Schema, Map<string, ReturnType<typeof Compile>>>();
  const exhausted = Symbol('diagnostic budget');
  let checks = 0;
  const valid = (node: Schema, instance: unknown, keyword = ''): boolean => {
    if (++checks > MAX_CHECKS) throw exhausted;
    let byKeyword = validators.get(node);
    if (!byKeyword) validators.set(node, byKeyword = new Map());
    let validator = byKeyword.get(keyword);
    if (!validator) {
      const schema = keyword ? isolatedKeyword(node, keyword) : node;
      if (!schema) return true;
      byKeyword.set(keyword, validator = Compile(schema as TSchema));
    }
    return validator.Check(instance);
  };
  const report = (schemaPath: string, keyword: string) => {
    if (schemaPath.length <= 160 && keyword.length <= 40 && !/[\x00-\x1f\x7f]/.test(schemaPath) && /^[A-Za-z]+$/.test(keyword) &&
      !issues.some(issue => issue.schemaPath === schemaPath && issue.keyword === keyword)) issues.push({ schemaPath, keyword });
    if (issues.length >= MAX_ISSUES) throw exhausted;
  };
  const visit = (node: Schema, instance: unknown, path: string): void => {
    let located = false;
    const descend = (child: unknown, childInstance: unknown, childPath: string) => {
      if (isSchema(child) && !valid(child, childInstance)) { located = true; visit(child, childInstance, childPath); }
    };
    for (const keyword of Object.keys(node)) {
      if (annotations.has(keyword) || keyword === 'properties' || keyword === 'items' || (keyword === 'additionalProperties' && isSchema(node[keyword]))) continue;
      if (valid(node, instance, keyword)) continue;
      const branch = keyword === 'anyOf' || keyword === 'oneOf' ? discriminatedBranch(node[keyword], instance) : undefined;
      if (keyword === 'allOf') (node.allOf as unknown[]).forEach((entry, index) => descend(entry, instance, `${path}/allOf/${index}`));
      else if (branch !== undefined && !valid((node[keyword] as Schema[])[branch], instance)) descend((node[keyword] as Schema[])[branch], instance, `${path}/${keyword}/${branch}`);
      else { located = true; report(path, keyword); }
    }
    if (isSchema(instance) && isSchema(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) if (Object.hasOwn(instance, key)) descend(child, instance[key], `${path}/properties/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
    if (isSchema(instance) && isSchema(node.additionalProperties)) {
      for (const key of Object.keys(instance)) if (!isSchema(node.properties) || !Object.hasOwn(node.properties, key)) descend(node.additionalProperties, instance[key], `${path}/additionalProperties`);
    }
    if (Array.isArray(instance) && isSchema(node.items)) for (const item of instance) descend(node.items, item, `${path}/items`);
    // A failure only visible through sibling keywords together is reported at its subschema.
    if (!located) report(path, 'schema');
  };
  try { visit(root, value, '#'); }
  catch (error) { if (error !== exhausted) throw error; }
  return issues;
}

/** Bound diagnostic work even for flat objects with many extra keys. */
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
  return content => {
    if (Buffer.byteLength(content) > MAX_BYTES) return { valid: false, diagnostic: { category: 'over_size' } };
    if (!content.trim()) return { valid: false, diagnostic: { category: 'empty' } };
    let final: unknown;
    try { final = JSON.parse(content); }
    catch {
      return { valid: false, diagnostic: { category: containsJson(content) ? 'wrapped_json' : 'not_json' } };
    }
    if (validator.Check(final)) return { valid: true, final };
    if (!smallDiagnosticValue(final)) return { valid: false, diagnostic: { category: 'schema_mismatch' } };
    const issues = locateFailures(schema, final);
    return { valid: false, diagnostic: { category: 'schema_mismatch', ...(issues.length ? { issues } : {}) } };
  };
}

export function finalResultDescription({ category, issues }: FinalResultDiagnostic): string {
  return category + (issues?.length ? ` ${JSON.stringify(issues)}` : '');
}

/** Broker allowlist: never persist caller-supplied messages, paths or response fields for these events. */
export function finalResultEventData(event: Record<string, unknown>): Record<string, string> | undefined {
  const { attempt, category, outcome } = event;
  if (event.type === 'executor.final.invalid' && typeof attempt === 'string' && ['initial', 'repair'].includes(attempt) &&
    typeof category === 'string' && ['empty', 'not_json', 'wrapped_json', 'schema_mismatch', 'over_size', 'result_check'].includes(category)) {
    return { attempt, category };
  }
  if (event.type === 'executor.final.repair' && typeof outcome === 'string' && ['started', 'succeeded', 'failed'].includes(outcome)) return { outcome };
  return undefined;
}
