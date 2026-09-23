import type { InferSchema, JsonSchema, ToolDefinition, ToolMetadata } from './tools/contracts.js';
export type * from './tools/contracts.js';
export type * from './definitions.js';
export { resolveScopePath } from './artifact-scope.js';
/** An optional script-authoring helper, not a configuration registration API. */
export function defineTool<const S extends JsonSchema>(tool: Omit<ToolDefinition<InferSchema<S>>, 'metadata'> & { metadata: Omit<ToolMetadata, 'inputSchema'> & { inputSchema: S } }): ToolDefinition<InferSchema<S>> { return tool; }
