import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import type { TValidationError } from 'typebox/error';
import type { EnvironmentRequirement, JsonSchema, ToolMetadata } from './contracts.js';
import { posix, win32 } from 'node:path';

export const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function jsonCopy<T>(value: T): T {
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (object(item) && Object.getPrototypeOf(item) === Object.prototype) { Object.values(item).forEach(visit); return; }
    throw new Error('Tool declarations and results must contain only JSON values.');
  };
  visit(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('Tool JSON exceeds the supported size.');
  return JSON.parse(JSON.stringify(value)) as T;
}
const keywords = new Set(['type','description','title','default','examples','enum','const','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','anyOf','oneOf','allOf','not']);
export function validateSchema(schema: unknown): asserts schema is JsonSchema {
  if (!object(schema) || schema.type !== 'object') throw new Error('A tool input schema must declare an object.');
  const walk = (node: unknown, depth: number): void => {
    if (depth > 20 || !object(node)) throw new Error('Invalid or deeply nested tool schema.');
    for (const key of Object.keys(node)) if (!keywords.has(key)) throw new Error(`Unsupported tool schema keyword: ${key}`);
    if (node.type !== undefined && !['object','array','string','integer','number','boolean','null'].includes(node.type)) throw new Error('Unsupported schema type; use anyOf for unions.');
    if (node.properties !== undefined) { if (!object(node.properties)) throw new Error('Invalid schema properties'); for (const item of Object.values(node.properties)) walk(item,depth+1); }
    if (node.items !== undefined) walk(node.items,depth+1);
    if (object(node.additionalProperties)) walk(node.additionalProperties,depth+1);
    for (const key of ['anyOf','allOf','oneOf']) if (node[key] !== undefined) { if (!Array.isArray(node[key]) || !node[key].length) throw new Error(`Invalid ${key}`); node[key].forEach((item:unknown)=>walk(item,depth+1)); }
    if (node.not !== undefined) walk(node.not,depth+1);
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean' && !object(node.additionalProperties)) throw new Error('Invalid schema additionalProperties');
    for (const key of ['minItems','maxItems','minLength','maxLength']) if (node[key] !== undefined && (!Number.isSafeInteger(node[key]) || node[key] < 0)) throw new Error(`Invalid schema ${key}`);
    for (const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum']) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) throw new Error(`Invalid schema ${key}`);
    if (node.multipleOf !== undefined && (typeof node.multipleOf !== 'number' || !Number.isFinite(node.multipleOf) || node.multipleOf <= 0)) throw new Error('Invalid schema multipleOf');
    if (node.uniqueItems !== undefined && typeof node.uniqueItems !== 'boolean') throw new Error('Invalid schema uniqueItems');
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || new Set(node.enum.map((value:unknown) => JSON.stringify(value))).size !== node.enum.length)) throw new Error('Invalid schema enum');
    if (node.examples !== undefined && !Array.isArray(node.examples)) throw new Error('Invalid schema examples');
    for (const key of ['title','description']) if (node[key] !== undefined && typeof node[key] !== 'string') throw new Error(`Invalid schema ${key}`);
    if (node.pattern !== undefined && (typeof node.pattern !== 'string' || node.pattern.length > 1000)) throw new Error('Invalid schema pattern');
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some((v:unknown)=>typeof v!=='string') || new Set(node.required).size!==node.required.length)) throw new Error('Invalid schema required');
  };
  jsonCopy(schema); walk(schema,0); Compile(Type.Unsafe(schema));
}
const argumentFailures = new WeakMap<Error, string>();
/** Only errors created by argument validation may cross the diagnostic boundary. */
export function toolArgumentErrorMessage(error: unknown): string | undefined {
  return error instanceof Error ? argumentFailures.get(error) : undefined;
}

function diagnosticName(value: string): string {
  // Bound the quoted UTF-8 form; control characters cannot forge diagnostic lines.
  let prefix = '', bytes = 2;
  for (const character of value) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > 160) return `${JSON.stringify(prefix)} (truncated)`;
    prefix += character;
  }
  return JSON.stringify(prefix);
}
const pointerToken = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
function diagnosticPaths(args: unknown, instancePath: string): string {
  // TypeBox currently joins property names without JSON Pointer escaping. Recover
  // escaped paths from argument keys only; report alternatives if that join is ambiguous.
  const pending = [{ value: args, raw: '', pointer: '' }], paths: string[] = [];
  while (pending.length && paths.length < 6) {
    const current = pending.pop()!;
    if (current.raw === instancePath) { paths.push(diagnosticName(current.pointer)); continue; }
    if (!object(current.value) && !Array.isArray(current.value)) continue;
    for (const key of Object.keys(current.value)) {
      const raw = `${current.raw}/${key}`;
      if (instancePath === raw || instancePath.startsWith(`${raw}/`)) pending.push({ value: (current.value as Record<string, unknown>)[key], raw, pointer: `${current.pointer}/${pointerToken(key)}` });
    }
  }
  return paths.length ? paths.slice(0, 5).join(' or ') + (paths.length > 5 ? ' (more paths omitted)' : '') : diagnosticName(instancePath);
}
function argumentReason(error: TValidationError): string {
  const names = (values: string[]) => values.slice(0, 3).map(diagnosticName).join(', ') + (values.length > 3 ? ' (more properties omitted)' : '');
  switch (error.keyword) {
    case 'additionalProperties': return `unexpected or invalid property: ${names(error.params.additionalProperties)}`;
    case 'required': return `missing required property: ${names(error.params.requiredProperties)}`;
    case 'type': {
      const types = Array.isArray(error.params.type) ? error.params.type : [error.params.type];
      return `expected ${types.filter(type => ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(type)).join(' or ') || 'registered type'}`;
    }
    case 'enum': return 'expected one of the registered enum values';
    case 'const': return 'expected the registered constant';
    case 'pattern': return 'must match the registered pattern';
    case 'anyOf': return 'must match at least one registered alternative';
    case 'oneOf': return 'must match exactly one registered alternative';
    case 'not': return 'must not match the excluded schema';
    case 'uniqueItems': return 'array items must be unique';
    default: return 'does not satisfy the registered constraint';
  }
}
function argumentMessage(errors: TValidationError[], args: unknown): string {
  let message = 'Tool arguments do not match the registered input schema.';
  const omitted = '\nAdditional diagnostics omitted.';
  let shown = 0;
  for (const error of errors.slice(0, 5)) {
    // Do not forward TypeBox messages or arbitrary params: they can contain values.
    const line = `\n- instancePath ${diagnosticPaths(args, error.instancePath)} [${error.keyword}]: ${argumentReason(error)}.`;
    if (Buffer.byteLength(message + line + omitted) > 4096) break;
    message += line; shown++;
  }
  return message + (shown < errors.length ? omitted : '');
}
export function validateArguments(schema: JsonSchema, args: unknown): Record<string, unknown> {
  if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > 65536) throw new Error('Tool arguments must be an object of at most 64 KiB.');
  const actual = jsonCopy(args);
  const validator = Compile(Type.Unsafe(schema));
  if (!validator.Check(actual)) {
    const message = argumentMessage(validator.Errors(actual), actual);
    const error = new Error(message);
    argumentFailures.set(error, message);
    throw error;
  }
  return actual;
}
export function metadata(value: unknown): ToolMetadata {
  const result = jsonCopy(value);
  if (!object(result) || Object.keys(result).some(key=>!['description','inputSchema','resultKinds','observation','artifactKind','timeoutMs','executionPaths'].includes(key))) throw new Error('Invalid tool metadata.');
  if (typeof result.description !== 'string' || !result.description.trim() || result.description.length>4000 || /[{}]/.test(result.description.replaceAll('{artifactName}',''))) throw new Error('Tool description requires text and supports only {artifactName}.');
  validateSchema(result.inputSchema);
  if (!Array.isArray(result.resultKinds) || !result.resultKinds.length || new Set(result.resultKinds).size!==result.resultKinds.length || result.resultKinds.some((v:unknown)=>!['text','json','image','launch'].includes(v as string))) throw new Error('Invalid tool resultKinds.');
  if (!['content','none'].includes(result.observation) || (result.artifactKind!==undefined && !['file','directory','any'].includes(result.artifactKind))) throw new Error('Invalid tool observation or artifact kind.');
  if (result.timeoutMs!==undefined && (!Number.isSafeInteger(result.timeoutMs)||result.timeoutMs<1||result.timeoutMs>900000)) throw new Error('Tool timeoutMs must be 1–900000.');
  if (result.executionPaths !== undefined) declaredPaths(result.executionPaths);
  return result as unknown as ToolMetadata;
}

export function projectInputPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || posix.isAbsolute(value) || win32.isAbsolute(value) || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Execution input must be a safe project-relative path.');
  }
}

function declaredPaths(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length) throw new Error('Execution inputs must be at most 64 unique project-relative paths.');
  value.forEach(projectInputPath);
}

export function environmentRequirements(value: unknown): Record<string, EnvironmentRequirement> {
  if (!object(value) || Object.keys(value).length > 32) throw new Error('envRequirements must be a map of at most 32 checks.');
  const result = jsonCopy(value);
  for (const [id, requirement] of Object.entries(result)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !object(requirement) || Object.keys(requirement).some(key => !['description','script','timeoutMs','inputs'].includes(key))) throw new Error('Invalid environment requirement.');
    if (typeof requirement.description !== 'string' || !requirement.description.trim() || requirement.description.length > 2000) throw new Error(`Environment requirement ${id} needs a description.`);
    projectInputPath(requirement.script);
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(requirement.script)) throw new Error(`Environment requirement ${id} must use a Node JavaScript or TypeScript script.`);
    if (requirement.timeoutMs !== undefined && (!Number.isSafeInteger(requirement.timeoutMs) || requirement.timeoutMs < 1 || requirement.timeoutMs > 900000)) throw new Error('Environment timeoutMs must be 1–900000.');
    if (requirement.inputs !== undefined) declaredPaths(requirement.inputs);
  }
  return result as Record<string, EnvironmentRequirement>;
}
