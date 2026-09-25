import { Compile } from 'typebox/compile';
import type { JsonSchema } from './tools/contracts.js';
import { jsonCopy, object, validateSchema } from './tools/schema.js';

export interface ResponseSchemas { passSchema?: JsonSchema; failSchema?: JsonSchema }
export const auditFields = new Set(['provider', 'model', 'stdout', 'stderr', 'durationMs', 'exitCode', 'toolCalls']);
const reserved = new Set(['verdict', 'reference', 'reusedFrom', ...auditFields]);

/** Owner schemas describe extra top-level result fields, never transport or audit fields. */
export function validateResponseSchema(schema: unknown): asserts schema is JsonSchema {
  validateSchema(schema);
  if (Object.keys(schema.properties ?? {}).some(key => reserved.has(key))) throw new Error('Response schemas cannot declare reserved result fields.');
  if (((schema.required ?? []) as string[]).some(key => reserved.has(key))) throw new Error('Response schemas cannot require reserved result fields.');
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error('Response schemas must forbid undeclared top-level fields.');
}
export function finalResultSchema(schemas: ResponseSchemas = {}): JsonSchema {
  const branch = (verdict: 'GREEN' | 'RED', schema?: JsonSchema) => ({
    ...schema, type: 'object', additionalProperties: false,
    properties: { ...(schema?.properties as Record<string, unknown> | undefined), verdict: { const: verdict, type: 'string' } },
    required: ['verdict', ...((schema?.required ?? []) as string[])],
  });
  return { type: 'object', oneOf: [branch('GREEN', schemas.passSchema), branch('RED', schemas.failSchema)] };
}
export function semanticResult(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !auditFields.has(key)));
}
export function validateFinalResult(value: unknown, schemas: ResponseSchemas = {}): Record<string, unknown> & { verdict: 'GREEN' | 'RED' } {
  if (!object(value) || !Compile(finalResultSchema(schemas)).Check(value)) throw new Error('Review result does not match the verdict and owner response schema.');
  return jsonCopy(value) as Record<string, unknown> & { verdict: 'GREEN' | 'RED' };
}
