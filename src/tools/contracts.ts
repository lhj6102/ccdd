import type { ArtifactDefinition, CriticDefinition } from '../contracts.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type ToolResultKind = 'text' | 'json' | 'image' | 'launch';
export interface ToolMetadata {
  description: string;
  inputSchema: JsonSchema;
  resultKinds: ToolResultKind[];
  observation: 'content' | 'none';
  artifactKind?: 'file' | 'directory' | 'any';
  timeoutMs?: number;
}
export interface ToolContext {
  artifactId: string;
  artifactPath: string;
  artifactDirectory: boolean;
  outputDir: string;
  tmpDir: string;
  signal: AbortSignal;
  resolvePath(path?: string): Promise<string>;
}
export type ToolContent = { type: 'text'; text: string } | { type: 'json'; data: JsonValue }
  | { type: 'image'; path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { type: 'launch'; launched: true };
export interface ToolResult { content: ToolContent[]; observation?: { kind: 'content' | 'empty'; detail?: string } }
export interface ToolDefinition<Args = Record<string, unknown>> {
  metadata: ToolMetadata;
  execute(context: ToolContext, args: Args): ToolResult | Promise<ToolResult>;
  preflight?(context: ToolContext): { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
}
export interface ArtifactToolsConfig { agentTools?: Record<string, ToolDefinition<any>>; humanTools?: Record<string, ToolDefinition<any>> }
export interface Config { artifacts: Record<string, ArtifactDefinition>; artifactTypes: Record<string, ArtifactToolsConfig>; critics: CriticDefinition[] }
export type ConfigFactory = () => Config | Promise<Config>;
export interface ConfigManifest {
  version: 1;
  configHash: string;
  modules: { path: string; hash: string }[];
  types: Record<string, { agentTools: Record<string, ToolMetadata>; humanTools: Record<string, ToolMetadata> }>;
}
type Properties<S> = S extends { properties: infer P } ? P : {};
type RequiredKeys<S> = S extends { required: readonly (infer K)[] } ? K : never;
export type InferSchema<S> = S extends { enum: readonly (infer E)[] } ? E
  : S extends { type: 'string' } ? string : S extends { type: 'number' | 'integer' } ? number
  : S extends { type: 'boolean' } ? boolean : S extends { type: 'null' } ? null
  : S extends { type: 'array'; items: infer I } ? InferSchema<I>[]
  : S extends { type: 'object' } ? { [K in keyof Properties<S> as K extends RequiredKeys<S> ? K : never]: InferSchema<Properties<S>[K]> } & { [K in keyof Properties<S> as K extends RequiredKeys<S> ? never : K]?: InferSchema<Properties<S>[K]> }
  : unknown;
