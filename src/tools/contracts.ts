import type { ArtifactEntryDefinition, CriticDefinition } from '../definitions.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type ToolResultKind = 'text' | 'json' | 'image' | 'launch';
export interface ToolMetadata {
  description: string;
  inputSchema: JsonSchema;
  resultKinds: ToolResultKind[];
  observation: 'content' | 'none';
  artifactKind?: 'file' | 'directory' | 'any' | 'data';
  timeoutMs?: number;
  /** Project-relative runtime files or directories whose bytes affect this tool. */
  executionPaths?: string[];
}
export interface ToolContext {
  artifactId: string;
  artifactPath: string;
  artifactDirectory: boolean;
  outputDir: string;
  tmpDir: string;
  signal: AbortSignal;
  resolvePath(path?: string): Promise<string>;
  /** Resolve only paths explicitly registered in metadata.executionPaths. */
  resolveExecutionPath?(path: string): Promise<string>;
}
export type ToolContent = { type: 'text'; text: string } | { type: 'json'; data: JsonValue }
  | { type: 'image'; path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { type: 'launch'; launched: true };
export interface ToolResult { content: ToolContent[]; observation?: { kind: 'content' | 'empty'; detail?: string } }
/** Data tools receive only their bound, captured Artifact data. */
export interface DataToolContext {
  artifactId: string;
  outputDir: string;
  tmpDir: string;
  signal: AbortSignal;
  readData(): JsonValue;
  resolveExecutionPath(path: string): Promise<string>;
}
export interface ArtifactIdentityStrategy { kind: 'canonical-data' | 'immutable-revision' | 'custom'; namespace: string; version: string }
export interface ArtifactSourceMetadata {
  identity: ArtifactIdentityStrategy;
  /** Queries may invoke only sources explicitly declaring read-only preparation. */
  preparation: 'read-only' | 'explicit';
  timeoutMs?: number;
}
export interface ArtifactSourceContext {
  artifactId: string;
  params: JsonValue;
  signal: AbortSignal;
  /** Resolve captured project files, never the mutable original copy source. */
  resolvePath(path: string): Promise<string>;
}
export interface ArtifactSourceResult { data: JsonValue; revision?: string }
export interface ArtifactSourceDefinition {
  metadata: ArtifactSourceMetadata;
  prepare(context: ArtifactSourceContext): ArtifactSourceResult | Promise<ArtifactSourceResult>;
  /** A custom identity asserts equivalence of the complete supplied data. */
  fingerprint?(data: JsonValue): string | Promise<string>;
}
export interface PreparedArtifactData {
  version: 1;
  identity: ArtifactIdentityStrategy & { fingerprint: string };
  /** Integrity hash of the canonical data, independent of semantic equivalence. */
  contentHash: string;
  data: JsonValue;
  revision?: string;
}
export interface ToolDefinition<Args = Record<string, unknown>, Context = ToolContext> {
  metadata: ToolMetadata;
  execute(context: Context, args: Args): ToolResult | Promise<ToolResult>;
  preflight?(context: Context): { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
}
export interface ArtifactToolsConfig { agentTools?: Record<string, ToolDefinition<any, any>>; humanTools?: Record<string, ToolDefinition<any, any>> }
export interface EnvironmentRequirement {
  description: string;
  /** Project-relative Node script; a zero exit status confirms readiness. */
  script: string;
  timeoutMs?: number;
  /** Additional project files or directories used by the check. */
  inputs?: string[];
}
export interface Config { artifacts: Record<string, ArtifactEntryDefinition>; artifactTypes: Record<string, ArtifactToolsConfig>; critics: CriticDefinition[]; envRequirements?: Record<string, EnvironmentRequirement>; artifactSources?: Record<string, ArtifactSourceDefinition> }
export type ConfigFactory = () => Config | Promise<Config>;
export interface ConfigManifest {
  version: 1;
  configHash: string;
  modules: { path: string; hash: string }[];
  types: Record<string, { agentTools: Record<string, ToolMetadata>; humanTools: Record<string, ToolMetadata> }>;
  envRequirements?: Record<string, EnvironmentRequirement>;
  environmentInputs?: { path: string; hash: string }[];
  executionInputs?: { path: string; hash: string }[];
  sources?: Record<string, ArtifactSourceMetadata>;
}
type Properties<S> = S extends { properties: infer P } ? P : {};
type RequiredKeys<S> = S extends { required: readonly (infer K)[] } ? K : never;
export type InferSchema<S> = S extends { enum: readonly (infer E)[] } ? E
  : S extends { type: 'string' } ? string : S extends { type: 'number' | 'integer' } ? number
  : S extends { type: 'boolean' } ? boolean : S extends { type: 'null' } ? null
  : S extends { type: 'array'; items: infer I } ? InferSchema<I>[]
  : S extends { type: 'object' } ? { [K in keyof Properties<S> as K extends RequiredKeys<S> ? K : never]: InferSchema<Properties<S>[K]> } & { [K in keyof Properties<S> as K extends RequiredKeys<S> ? never : K]?: InferSchema<Properties<S>[K]> }
  : unknown;
