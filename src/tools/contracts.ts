import type { ArtifactDefinition, ArtifactManifest, ArtifactScope } from '../definitions.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;
export type ToolResultKind = 'text' | 'json' | 'image' | 'launch';
export interface ToolMetadata {
  description: string; inputSchema: JsonSchema; resultKinds: ToolResultKind[];
  observation: 'content' | 'none'; artifactKind?: 'file' | 'directory' | 'any'; timeoutMs?: number;
  /** Workspace-relative runtime material whose content affects this tool. */
  executionPaths?: string[];
}
export interface ScriptDefinition { command: string; args: string[] }
export interface ScriptToolDefinition { metadata: ToolMetadata; script: ScriptDefinition }
export interface ArtifactViews { agentTools?: Record<string, ScriptToolDefinition>; humanTools?: Record<string, ScriptToolDefinition> }
export type ToolContent = { type: 'text'; text: string } | { type: 'json'; data: JsonValue }
  | { type: 'image'; path: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }
  | { type: 'launch'; launched: true };
export type ToolResult =
  | { content: ToolContent[]; observation?: { kind: 'content' | 'empty'; detail?: string }; isError?: never }
  | { isError: true; content: [{ type: 'text'; text: string }]; observation?: never };
export interface ScriptToolContext {
  artifactId: string; artifactPath: string; outputDir: string; tmpDir: string;
  /** Canonical paths and logical connections for this review's allowed scope. */
  scope: ArtifactScope;
}
export interface ScriptToolRequest { version: 1; context: ScriptToolContext; args: Record<string, unknown> }
/** Convenience interface for script authors. Project never imports these functions. */
export interface ToolContext extends ScriptToolContext {
  artifactDirectory: boolean; signal: AbortSignal;
  resolvePath(path?: string): Promise<string>;
  resolveExecutionPath?(path: string): Promise<string>;
}
export interface ToolDefinition<Args = Record<string, unknown>, Context = ToolContext> {
  metadata: ToolMetadata;
  execute(context: Context, args: Args): ToolResult | Promise<ToolResult>;
  preflight?(context: Context): { ok: boolean; message: string } | Promise<{ ok: boolean; message: string }>;
}
export interface EnvironmentRequirement { description: string; script: string; timeoutMs?: number; inputs?: string[] }
export interface ConfigManifest {
  version: 2; configHash: string; artifacts: Record<string, ArtifactDefinition>;
  declarations: { path: string; hash: string }[];
  executionInputs?: { path: string; hash: string }[];
  envRequirements?: Record<string, EnvironmentRequirement>;
  environmentInputs?: { path: string; hash: string }[];
}
export type { ArtifactManifest };
type Properties<S> = S extends { properties: infer P } ? P : {};
type RequiredKeys<S> = S extends { required: readonly (infer K)[] } ? K : never;
export type InferSchema<S> = S extends { enum: readonly (infer E)[] } ? E
  : S extends { type: 'string' } ? string : S extends { type: 'number' | 'integer' } ? number
  : S extends { type: 'boolean' } ? boolean : S extends { type: 'null' } ? null
  : S extends { type: 'array'; items: infer I } ? InferSchema<I>[]
  : S extends { type: 'object' } ? { [K in keyof Properties<S> as K extends RequiredKeys<S> ? K : never]: InferSchema<Properties<S>[K]> } & { [K in keyof Properties<S> as K extends RequiredKeys<S> ? never : K]?: InferSchema<Properties<S>[K]> }
  : unknown;
