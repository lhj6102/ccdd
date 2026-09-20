import type { ArtifactSourceDefinition, DataToolContext, Config, ConfigFactory, InferSchema, JsonSchema, ToolDefinition, ToolMetadata } from './tools/contracts.js';
export type * from './tools/contracts.js';
export type * from './definitions.js';
export function defineConfig<T extends Config | ConfigFactory>(config: T): T { return config; }
export function defineTool<const S extends JsonSchema>(tool: Omit<ToolDefinition<InferSchema<S>>, 'metadata'> & { metadata: Omit<ToolMetadata, 'inputSchema'> & { inputSchema: S } }): ToolDefinition<InferSchema<S>> { return tool; }
export function defineDataTool<const S extends JsonSchema>(tool: Omit<ToolDefinition<InferSchema<S>, DataToolContext>, 'metadata'> & { metadata: Omit<ToolMetadata, 'inputSchema' | 'artifactKind'> & { inputSchema: S } }): ToolDefinition<InferSchema<S>, DataToolContext> { return { ...tool, metadata: { ...tool.metadata, artifactKind: 'data' } }; }
export function defineArtifactSource(source: ArtifactSourceDefinition): ArtifactSourceDefinition { return source; }
