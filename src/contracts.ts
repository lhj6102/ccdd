import type { ArtifactReference, ArtifactToolCall } from './artifacts/index.js';
import type { WorkspaceDescriptor } from './workspaces/index.js';
import type { ResponseSchemas } from './response-schema.js';
import type { ConfigManifest } from './tools/contracts.js';
import type { CriticProfile, ReviewPayload, ResolvedCriticDefinition, ArtifactDefinition, ArtifactRelation, ResultCheck } from './definitions.js';
import type { ValidationInput } from './project/types.js';
import type { HumanTryClaim, HumanPreparationAttempt } from './broker/human-claims.js';
export type * from './definitions.js';

export type { ArtifactReference, ArtifactToolCall } from './artifacts/index.js';
export type { WorkspaceDescriptor, WorkspaceHandle, WorkspaceIntegrity } from './workspaces/index.js';

export interface ReviewEnvelope extends ResponseSchemas {
  repoId: string; snapshotHash: string; criticId: string; title: string;
  artifacts: ArtifactReference[]; references: Record<string, string>; requiredObservations: string[];
  configManifest: ConfigManifest;
  payload: ReviewPayload; profile: CriticProfile; target: string; deps: string[];
  resultCheck?: ResultCheck;
}
export type ReviewStatus = 'WAIT_DEPENDENCY' | 'BLOCKED' | 'QUEUED' | 'RUNNING' | 'WAITING_HUMAN' | 'GREEN' | 'RED' | 'ERROR';
export type RunStatus = ReviewStatus | 'INCOMPLETE';
export interface ReviewToolCall {
  name: string; arguments?: unknown; at?: string; isError?: true;
  observation?: { artifactId: string; operation: string; kind?: 'content' | 'empty'; detail?: string; startLine?: number | null; endLine?: number | null; lineCount?: number | null; totalLines?: number | null };
}
export interface ReviewResult {
  verdict: 'GREEN' | 'RED'; [field: string]: unknown;
  provider?: string; model?: string; stdout?: string; stderr?: string;
  durationMs?: number; exitCode?: number; toolCalls?: ReviewToolCall[];
}
export interface ExecutionSource {
  stateDir: string; runId: string; requestId: string; executionId: string; identity: string;
}
export interface ReviewRequest extends ReviewEnvelope {
  /** Subscriber attribution. It is not an additional cache key. */
  executionSource?: ExecutionSource;
  requestedProfile?: CriticProfile;
  cacheDisposition?: 'hit' | 'coalesced' | 'executed';
  /** Identity of the input actually reviewed; provided by project validation. */
  validationInput?: ValidationInput;
  attemptId?: string;
  executionProvenance?: import('./provenance.js').ExecutionProvenance | null;
  id: string; runId: string; workspace: WorkspaceDescriptor; worktreePath: string;
  status: ReviewStatus; createdAt: string;
  startedAt?: string | null; completedAt?: string | null; claimedBy?: string | null; claimedAt?: string | null;
  tryClaim?: HumanTryClaim;
  preparationAttempt?: HumanPreparationAttempt;
  claimAttemptId?: string;
  notifiedAt?: string | null; errorCode?: string | null; blockedReason?: string | null;
  result?: ReviewResult | null; error?: string | null;
  /** Full detail of an ERROR request: its last attempt's recorded calls, bounded; later calls are counted in toolCallsOmitted. */
  toolCalls?: ReviewToolCall[]; toolCallsOmitted?: number;
  /** Full detail: summed usage counters Pi reported for this request's current attempt, for every status. */
  usage?: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'reasoning' | 'totalTokens', number>>;
}
export interface RepoConfig {
  artifacts: Record<string, ArtifactDefinition>; critics: ResolvedCriticDefinition[];
  relations: ArtifactRelation[]; configManifest: ConfigManifest; reviewPolicy?: import('./definitions.js').ReviewPolicy;
}
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
