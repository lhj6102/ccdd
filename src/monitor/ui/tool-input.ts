import { Check, Errors } from 'typebox/value';
import type { TSchema } from 'typebox';

export interface ToolField {
  name: string;
  label: string;
  description?: string;
  kind: 'string' | 'integer' | 'number' | 'boolean' | 'enum';
  required: boolean;
  options?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const labels: Record<string, string> = { path: '내부 경로', startLine: '시작 줄', lineCount: '읽을 줄 수', offset: '시작 항목', limit: '항목 수' };
const complexKeywords = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties', 'unevaluatedProperties'];
const simple = (schema: Record<string, unknown>) => !complexKeywords.some(key => key in schema);
const primitive = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** Only simple object schemas become fields. Everything else keeps its full JSON shape. */
export function toolInputForm(schema: Record<string, unknown>): { fields: ToolField[]; json: boolean } {
  if (schema.type !== 'object' || !simple(schema)) return { fields: [], json: true };
  const properties = schema.properties ?? {};
  if (!record(properties)) return { fields: [], json: true };
  if (!Object.keys(properties).length && schema.additionalProperties !== false) return { fields: [], json: true };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields: ToolField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!record(property) || !simple(property)) return { fields: [], json: true };
    const enumeration = Array.isArray(property.enum) && property.enum.length > 0 && property.enum.every(primitive) ? property.enum : undefined;
    const kind = enumeration ? 'enum' : property.type;
    if (kind !== 'string' && kind !== 'integer' && kind !== 'number' && kind !== 'boolean' && kind !== 'enum') return { fields: [], json: true };
    fields.push({ name, label: typeof property.title === 'string' ? property.title : labels[name] ?? name,
      description: typeof property.description === 'string' ? property.description : undefined,
      kind, required: required.includes(name), options: enumeration, default: property.default,
      minimum: typeof property.minimum === 'number' ? property.minimum : undefined,
      maximum: typeof property.maximum === 'number' ? property.maximum : undefined,
      minLength: typeof property.minLength === 'number' ? property.minLength : undefined,
      maxLength: typeof property.maxLength === 'number' ? property.maxLength : undefined,
    });
  }
  // A required key not described in properties cannot be represented by these fields.
  if (required.some(name => typeof name !== 'string' || !Object.hasOwn(properties, name))) return { fields: [], json: true };
  return { fields, json: false };
}

export function initialToolFields(fields: ToolField[], legacy = false): Record<string, string> {
  const legacyDefaults: Record<string, number> = { startLine: 1, lineCount: 80, offset: 0, limit: 100 };
  return Object.fromEntries(fields.map(field => {
    const value = field.default !== undefined ? field.default : legacy ? legacyDefaults[field.name] : undefined;
    return [field.name, value === undefined ? '' : field.kind === 'enum'
      ? String(field.options?.findIndex(option => JSON.stringify(option) === JSON.stringify(value)) ?? -1)
      : String(value)];
  }));
}

export function initialToolJson(schema: Record<string, unknown>): string {
  if (record(schema.default)) return JSON.stringify(schema.default, null, 2);
  const value: Record<string, unknown> = {};
  if (record(schema.properties)) for (const [name, property] of Object.entries(schema.properties)) {
    if (record(property) && property.default !== undefined) Object.defineProperty(value, name, { value: property.default, enumerable: true });
  }
  return JSON.stringify(value, null, 2);
}

export function validateToolInput(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error('도구 입력은 JSON 객체여야 합니다.');
  if (new TextEncoder().encode(JSON.stringify({ arguments: value })).byteLength > 32_768) throw new Error('도구 입력은 32KiB 이하여야 합니다.');
  // The interpreter works with the monitor CSP (no generated code/eval).
  if (!Check(schema as TSchema, value)) {
    const first = Errors(schema as TSchema, value)[0];
    throw new Error(`도구 입력 형식을 확인하세요.${first ? ` ${first.message}` : ''}`);
  }
  return value;
}

export function parseToolFields(schema: Record<string, unknown>, definitions: ToolField[], fields: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of definitions) {
    const value = fields[field.name] ?? '';
    if (!value && !field.required) continue;
    let parsed: unknown;
    if (field.kind === 'enum') {
      if (!/^\d+$/.test(value) || !field.options || Number(value) >= field.options.length) throw new Error(`${field.label}을 선택해 주세요.`);
      parsed = field.options[Number(value)];
    } else if (field.kind === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new Error(`${field.label}을 선택해 주세요.`);
      parsed = value === 'true';
    } else if (field.kind === 'number' || field.kind === 'integer') {
      const input = value.trim();
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(input)) throw new Error(`${field.label}에 숫자를 입력해 주세요.`);
      parsed = Number(input);
      if (!Number.isFinite(parsed) || (field.kind === 'integer' && !Number.isSafeInteger(parsed))) throw new Error(`${field.label}의 숫자 형식을 확인해 주세요.`);
    } else parsed = value;
    Object.defineProperty(args, field.name, { value: parsed, enumerable: true });
  }
  return validateToolInput(schema, args);
}

export function parseToolJson(schema: Record<string, unknown>, source: string): Record<string, unknown> {
  let input: unknown;
  try { input = JSON.parse(source); } catch { throw new Error('올바른 JSON을 입력해 주세요.'); }
  return validateToolInput(schema, input);
}
