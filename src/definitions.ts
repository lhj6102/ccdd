import type { ArtifactViews, EnvironmentRequirement, ScriptDefinition, JsonSchema } from './tools/contracts.js';

/** Public declarations contain data only; discovery never executes code. */
/** `maxToolCalls` and `maxTokens` are an optional review budget; like timeoutMs they are declared in ccdd.json. */
export interface AgentProfile { kind: 'agent'; provider: string; model: string; reasoning: string; timeoutMs?: number; maxToolCalls?: number; maxTokens?: number }
export interface HumanProfile { kind: 'human' }
export interface RuntimeProfile { kind: 'runtime'; command: string; args: string[]; timeoutMs?: number }
export type CriticProfile = AgentProfile | HumanProfile | RuntimeProfile;
export interface ReviewPayload { instruction: string; [key: string]: unknown }
/** An Agent Critic's owner-relative Node script that checks a schema-valid result against the review's tool calls. */
export interface ResultCheck { script: string; timeoutMs?: number }
export interface CriticDefinition { id: string; title: string; profile: CriticProfile; payload: ReviewPayload; passSchema?: JsonSchema; failSchema?: JsonSchema; resultCheck?: ResultCheck }
export type StaleStrategy = { kind: 'file-hash'; paths?: string[] } | { kind: 'always' }
  | { kind: 'identity'; script: ScriptDefinition; inputs?: string[]; timeoutMs?: number; weight?: number };
export interface ReviewPolicy { dependencyGates?: 'green' | 'ignore'; maxConcurrentExecutors?: number }
export interface ArtifactManifest {
  name: string; critics?: CriticDefinition[]; views?: ArtifactViews; mounts?: Record<string, string>;
  reviewPolicy?: ReviewPolicy; basis?: boolean; stale?: StaleStrategy; envRequirements?: Record<string, EnvironmentRequirement>;
}
export interface ArtifactDefinition {
  name: string; path: string; views: ArtifactViews; mounts: Record<string, string>;
  /** Nearest marked descendants, indexed by their physical relative paths. */
  children: Record<string, string>;
  reviewPolicy?: ReviewPolicy; basis?: boolean; stale?: StaleStrategy; envRequirements?: Record<string, EnvironmentRequirement>;
}
export interface ResolvedCriticDefinition extends CriticDefinition {
  localId: string; target: string; deps: string[];
  /** Original instruction names map to canonical Artifact identities. */
  references: Record<string, string>;
}
export interface ArtifactRelation {
  source: string; target: string; kind: 'child' | 'mount' | 'instruction'; name?: string; criticId?: string;
}
export interface ArtifactScopeEntry { path: string; children: Record<string, string>; mounts: Record<string, string> }
export type ArtifactScope = Record<string, ArtifactScopeEntry>;
