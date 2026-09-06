import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import type { JsonSchema, ToolMetadata } from './contracts.js';

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
export function validateArguments(schema: JsonSchema, args: unknown): Record<string, unknown> {
  if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > 65536) throw new Error('Tool arguments must be an object of at most 64 KiB.');
  const actual = jsonCopy(args);
  if (!Compile(Type.Unsafe(schema)).Check(actual)) throw new Error('Tool arguments do not match the registered input schema.');
  return actual;
}
export function metadata(value: unknown): ToolMetadata {
  const result = jsonCopy(value);
  if (!object(result) || Object.keys(result).some(key=>!['description','inputSchema','resultKinds','observation','artifactKind','timeoutMs'].includes(key))) throw new Error('Invalid tool metadata.');
  if (typeof result.description !== 'string' || !result.description.trim() || result.description.length>4000 || /[{}]/.test(result.description.replaceAll('{artifactName}',''))) throw new Error('Tool description requires text and supports only {artifactName}.');
  validateSchema(result.inputSchema);
  if (!Array.isArray(result.resultKinds) || !result.resultKinds.length || new Set(result.resultKinds).size!==result.resultKinds.length || result.resultKinds.some((v:unknown)=>!['text','json','image','launch'].includes(v as string))) throw new Error('Invalid tool resultKinds.');
  if (!['content','none'].includes(result.observation) || (result.artifactKind!==undefined && !['file','directory','any'].includes(result.artifactKind))) throw new Error('Invalid tool observation or artifact kind.');
  if (result.timeoutMs!==undefined && (!Number.isSafeInteger(result.timeoutMs)||result.timeoutMs<1||result.timeoutMs>900000)) throw new Error('Tool timeoutMs must be 1–900000.');
  return result as unknown as ToolMetadata;
}
