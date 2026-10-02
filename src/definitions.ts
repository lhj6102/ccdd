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
/**
 * One statically listed member of an Artifact family. Its params, merged shallowly over the family
 * defaults and its named variant, fill `{"$param": "/pointer"}` values in the shared views and Critics.
 */
export interface ArtifactInstanceDeclaration { variant?: string; params?: Record<string, unknown>; material?: string[] }
/** Instances are listed inline or in an owner-relative JSON file; discovery reads them and executes nothing. */
export interface ArtifactFamilyDeclaration {
  instances: string | Record<string, ArtifactInstanceDeclaration>;
  params?: Record<string, unknown>; variants?: Record<string, Record<string, unknown>>;
}
export interface ArtifactManifest {
  name: string; critics?: CriticDefinition[]; views?: ArtifactViews; mounts?: Record<string, string>;
  reviewPolicy?: ReviewPolicy; basis?: boolean; stale?: StaleStrategy; envRequirements?: Record<string, EnvironmentRequirement>;
  /** Declares several Artifacts that share this folder, its views and its Critics. `name` then names the family. */
  family?: ArtifactFamilyDeclaration;
}
/** How an instance Artifact belongs to its family. Paths are relative to the shared family folder. */
export interface ArtifactFamilyMembership {
  name: string;
  /** The static instance list file, when the list is not inline. */
  instances?: string;
  /** Material that only this instance's identity covers; other instances exclude it. */
  material: string[];
  /** Hash of this instance's static entry: its params and material list. */
  entry: string;
}
export interface ArtifactDefinition {
  name: string; path: string; views: ArtifactViews; mounts: Record<string, string>;
  /** Nearest marked descendants, indexed by their physical relative paths; a family instance is keyed `<family folder>/<instance>`. */
  children: Record<string, string>;
  reviewPolicy?: ReviewPolicy; basis?: boolean; stale?: StaleStrategy; envRequirements?: Record<string, EnvironmentRequirement>;
  family?: ArtifactFamilyMembership;
}
export interface ResolvedCriticDefinition extends CriticDefinition {
  localId: string; target: string; deps: string[];
  /** Original instruction names map to canonical Artifact identities. */
  references: Record<string, string>;
}
export interface ArtifactRelation {
  source: string; target: string; kind: 'child' | 'mount' | 'instruction'; name?: string; criticId?: string;
}
export interface ArtifactScopeEntry { path: string; children: Record<string, string>; mounts: Record<string, string>; family?: { name: string; material: string[] } }
export type ArtifactScope = Record<string, ArtifactScopeEntry>;
