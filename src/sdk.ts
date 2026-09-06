import type { Config, ConfigFactory, InferSchema, JsonSchema, ToolDefinition, ToolMetadata } from './tools/contracts.js';
export type * from './tools/contracts.js';
export type { ArtifactDefinition, ArtifactGroupDefinition, ArtifactEntryDefinition, ArtifactGroupReference } from './contracts.js';
export function defineConfig<T extends Config | ConfigFactory>(config: T): T { return config; }
export function defineTool<const S extends JsonSchema>(tool: Omit<ToolDefinition<InferSchema<S>>, 'metadata'> & { metadata: Omit<ToolMetadata, 'inputSchema'> & { inputSchema: S } }): ToolDefinition<InferSchema<S>> { return tool; }
