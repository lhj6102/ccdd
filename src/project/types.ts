import type { RepoConfig, ReviewEnvelope, ReviewResult, ReviewRequest, WorkspaceIntegrity } from '../contracts.js';

export type ProjectSelection = { kind: 'all' } | { kind: 'artifact'; artifactId: string } | { kind: 'critic'; criticId: string };
export interface ValidationInput {
  version: 2; key: string; criticHash: string;
  target: { id: string; hash: string }; deps: { id: string; hash: string }[];
  reusable: boolean;
  /** Omitted for historical/default content verification. Part of the effective Critic identity when nondefault. */
  workspaceIntegrity?: WorkspaceIntegrity;
}
export interface ArtifactIdentity { identity: 'script'; value: string }
export interface ProjectSnapshot {
  version: 2; config: RepoConfig; snapshotHash: string;
  artifactIdentities?: Record<string, ArtifactIdentity>;
  /** Prepared only for the selected dependency closure; config retains the full static graph. */
  artifactHashes: Record<string, string>; inputs: Record<string, ValidationInput>;
  workspaceIntegrity?: WorkspaceIntegrity;
}
export interface ValidationEvidence {
  requestId: string; runId: string; criticId: string; input: ValidationInput;
  completedAt: string; verdict: ReviewResult['verdict']; summary: string; evidence: string[];
}
export interface ProjectRunDefinition {
  version: 2; snapshot: ProjectSnapshot; selection: ProjectSelection;
  recursive: boolean; force: boolean;
  /** Prepared definitions, not tickets or persisted stale states. */
  templates: ReviewEnvelope[];
  /** Original evidence consumed by a completed execution; never a cached stale flag. */
  evidenceRequestIds?: string[];
}
export type ValidationStatus = 'PASS' | 'BASIS' | 'UNREVIEWED' | 'STALE' | 'RED' | 'ERROR' | 'INCOMPLETE' | 'QUEUED' | 'RUNNING' | 'WAITING_HUMAN';
export interface CriticValidation {
  id: string; title: string; target: string; deps: string[]; status: ValidationStatus;
  isStale: boolean; canExecute: boolean; needsReview: boolean; blockedBy: string[];
  reason: string; input: ValidationInput; result: ValidationEvidence | null;
  requestId: string | null;
}
export interface ArtifactValidation {
  identity?: 'script'; value?: string;
  id: string; hash: string; status: ValidationStatus; isStale: boolean;
  criticIds: string[]; passed: number; total: number;
}
export interface ProjectQuery {
  snapshotHash: string; selection: ProjectSelection; satisfied: boolean;
  workspaceIntegrity?: WorkspaceIntegrity;
  artifacts: ArtifactValidation[]; critics: CriticValidation[];
}
export interface ProjectPlan extends ProjectQuery {
  recursive: boolean; force: boolean; selectedCriticIds: string[]; includedCriticIds: string[];
  items: (CriticValidation & { action: 'REUSE' | 'EXECUTE' | 'WAIT' | 'ACTIVE' | 'FAILED' })[];
  counts: { reuse: number; execute: number; wait: number; active: number; failed: number };
}
export interface QueryOptions {
  selection?: ProjectSelection; forceCriticIds?: readonly string[];
  runId?: string; attempts?: readonly ReviewRequest[];
}
