import type { ArtifactViews, EnvironmentRequirement } from './tools/contracts.js';

/** Public declarations contain data only; discovery never executes code. */
export interface AgentProfile { kind: 'agent'; provider: string; model: string; reasoning: string; timeoutMs?: number }
export interface HumanProfile { kind: 'human' }
export interface RuntimeProfile { kind: 'runtime'; command: string; args: string[]; timeoutMs?: number }
export type CriticProfile = AgentProfile | HumanProfile | RuntimeProfile;
export interface ReviewPayload { instruction: string; [key: string]: unknown }
export interface CriticDefinition { id: string; title: string; profile: CriticProfile; payload: ReviewPayload }
export type StaleStrategy = { kind: 'file-hash'; paths?: string[] } | { kind: 'always' };
export interface ArtifactManifest {
  name: string; critics?: CriticDefinition[]; views?: ArtifactViews; mounts?: Record<string, string>;
  basis?: boolean; stale?: StaleStrategy; envRequirements?: Record<string, EnvironmentRequirement>;
}
export interface ArtifactDefinition {
  name: string; path: string; views: ArtifactViews; mounts: Record<string, string>;
  /** Nearest marked descendants, indexed by their physical relative paths. */
  children: Record<string, string>;
  basis?: boolean; stale?: StaleStrategy; envRequirements?: Record<string, EnvironmentRequirement>;
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
