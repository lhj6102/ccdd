/** The definition package has no dependency on persistence or review execution. */
export interface AgentProfile { kind: 'agent'; provider: string; model: string; reasoning: string; timeoutMs?: number }
export interface HumanProfile { kind: 'human' }
export interface RuntimeProfile { kind: 'runtime'; command: string; args: string[]; timeoutMs?: number }
export type CriticProfile = AgentProfile | HumanProfile | RuntimeProfile;
export interface ReviewPayload { instruction: string; [key: string]: unknown }
export interface CriticDefinition { id: string; title: string; target: string; deps: string[]; profile: CriticProfile; payload: ReviewPayload }
export type StaleStrategy = { kind: 'file-hash'; paths?: string[] } | { kind: 'always' };
export interface ArtifactDefinition { type: string; path: string; basis?: boolean; stale?: StaleStrategy }
export interface ArtifactGroupDefinition { kind: 'group'; members: string[]; basis?: boolean; stale?: StaleStrategy }
export type ArtifactEntryDefinition = ArtifactDefinition | ArtifactGroupDefinition;
export interface ArtifactGroupReference { id: string; members: string[] }
