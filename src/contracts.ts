import type { ArtifactReference, ArtifactTypeDefinition, ArtifactToolCall } from './artifacts/index.js';
import type { WorkspaceDescriptor } from './workspaces/index.js';

export type { ArtifactReference, ArtifactTypeDefinition, ArtifactToolCall } from './artifacts/index.js';
export type { WorkspaceDescriptor, WorkspaceHandle, WorkspaceMode } from './workspaces/index.js';

export interface AgentProfile { kind: 'agent'; provider: string; model: string; reasoning: string; timeoutMs?: number }
export interface HumanProfile { kind: 'human' }
export interface RuntimeProfile { kind: 'runtime'; command: string; args: string[]; timeoutMs?: number }
export type CriticProfile = AgentProfile | HumanProfile | RuntimeProfile;
export interface ReviewPayload { instruction: string; [key: string]: unknown }
export interface ReviewEnvelope {
  repoId: string; snapshotHash: string; criticId: string; title: string;
  artifacts: ArtifactReference[]; artifactTypes: Record<string, ArtifactTypeDefinition>;
  payload: ReviewPayload; profile: CriticProfile; target: string; deps: string[];
}
export type ReviewStatus = 'BLOCKED' | 'QUEUED' | 'RUNNING' | 'WAITING_HUMAN' | 'GREEN' | 'RED' | 'ERROR';
export interface ReviewToolCall {
  name: string; arguments?: unknown; at?: string;
  observation?: { artifactId: string; operation: 'read' | 'list'; startLine?: number | null; endLine?: number | null; lineCount?: number | null; totalLines?: number | null };
}
export interface ReviewResult {
  verdict: 'GREEN' | 'RED'; summary: string; evidence: string[];
  provider?: string; model?: string; stdout?: string; stderr?: string;
  durationMs?: number; exitCode?: number; toolCalls?: ReviewToolCall[];
}
export interface ReviewRequest extends ReviewEnvelope {
  id: string; runId: string; workspace: WorkspaceDescriptor; worktreePath: string;
  /** Present only on historical Critic-chain requests. New requests use target/deps. */
  predecessorId?: string | null; status: ReviewStatus; createdAt: string;
  startedAt?: string | null; completedAt?: string | null; claimedBy?: string | null; claimedAt?: string | null;
  notifiedAt?: string | null; errorCode?: string | null; blockedReason?: string | null;
  result?: ReviewResult | null; error?: string | null;
}
export interface CriticDefinition { id: string; title: string; target: string; deps: string[]; profile: CriticProfile; payload: ReviewPayload }
export interface ArtifactDefinition { type: string; path: string; basis?: boolean }
export interface RepoConfig { artifacts: Record<string, ArtifactDefinition>; artifactTypes: Record<string, ArtifactTypeDefinition>; critics: CriticDefinition[] }
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
