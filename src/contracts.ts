import type { ArtifactReference, ArtifactTypeDefinition, ArtifactToolCall } from './artifacts/index.js';
import type { WorkspaceDescriptor } from './workspaces/index.js';
import type { ConfigManifest } from './tools/contracts.js';
import type { CriticProfile, ReviewPayload, CriticDefinition, ArtifactEntryDefinition, ArtifactGroupReference } from './definitions.js';
import type { ValidationInput } from './project/types.js';
export type * from './definitions.js';

export type { ArtifactReference, ArtifactTypeDefinition, ArtifactToolCall } from './artifacts/index.js';
export type { WorkspaceDescriptor, WorkspaceHandle, WorkspaceMode } from './workspaces/index.js';

export interface ReviewEnvelope {
  repoId: string; snapshotHash: string; criticId: string; title: string;
  artifacts: ArtifactReference[]; artifactGroups?: ArtifactGroupReference[]; artifactTypes: Record<string, ArtifactTypeDefinition>;
  configManifest?: ConfigManifest;
  payload: ReviewPayload; profile: CriticProfile; target: string; deps: string[];
}
export type ReviewStatus = 'BLOCKED' | 'QUEUED' | 'RUNNING' | 'WAITING_HUMAN' | 'GREEN' | 'RED' | 'ERROR';
export type RunStatus = ReviewStatus | 'INCOMPLETE';
export interface ReviewToolCall {
  name: string; arguments?: unknown; at?: string;
  observation?: { artifactId: string; operation: string; kind?: 'content' | 'empty'; detail?: string; startLine?: number | null; endLine?: number | null; lineCount?: number | null; totalLines?: number | null };
}
export interface ReviewResult {
  verdict: 'GREEN' | 'RED'; summary: string; evidence: string[];
  provider?: string; model?: string; stdout?: string; stderr?: string;
  durationMs?: number; exitCode?: number; toolCalls?: ReviewToolCall[];
}
export interface ReviewRequest extends ReviewEnvelope {
  /** Identity of the input actually reviewed. Absent on historical requests. */
  validationInput?: ValidationInput;
  id: string; runId: string; workspace: WorkspaceDescriptor; worktreePath: string;
  /** Present only on historical Critic-chain requests. New requests use target/deps. */
  predecessorId?: string | null; status: ReviewStatus; createdAt: string;
  startedAt?: string | null; completedAt?: string | null; claimedBy?: string | null; claimedAt?: string | null;
  notifiedAt?: string | null; errorCode?: string | null; blockedReason?: string | null;
  result?: ReviewResult | null; error?: string | null;
}
export interface RepoConfig { artifacts: Record<string, ArtifactEntryDefinition>; artifactTypes: Record<string, ArtifactTypeDefinition>; critics: CriticDefinition[]; configManifest?: ConfigManifest }
export interface ExecutionEvent { type: string; [key: string]: unknown }
export interface ExecutionContext { worktreePath: string; workspacePath?: string; runDir: string; signal?: AbortSignal; onEvent?: (event: ExecutionEvent) => void | Promise<void> }
export type ExecutorReadiness = { ok: true } | { ok: false; code?: string; reason: string; remedy?: string };
export interface ProbeResult { ok: boolean; message: string; remedy?: string; details: Record<string, unknown> }
export interface AlarmMethod { id: string; notify: (request: ReviewRequest) => void | Promise<void> }
export interface ExecutorRegistry {
  validateWorkspace?(repoPath: string): void | Promise<void>;
  canExecute(request: ReviewEnvelope): ExecutorReadiness | Promise<ExecutorReadiness>;
  execute(request: ReviewRequest, context: ExecutionContext): Promise<ReviewResult>;
  probe?(request: ReviewEnvelope, context: ExecutionContext): Promise<ProbeResult>;
  notifyHuman?(request: ReviewRequest, context?: { signal?: AbortSignal }): unknown | Promise<unknown>;
}
