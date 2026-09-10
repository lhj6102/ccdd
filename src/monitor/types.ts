import type { ArtifactGroupReference, ArtifactReference, CriticProfile, ReviewStatus, RunStatus } from '../contracts.js';
import type { GraphProjection } from '../broker/graph.js';
import type { ArtifactCallResult } from '../artifacts/index.js';
import type { ProjectPlan } from '../project/types.js';

export type MonitorLane = 'requested' | 'running' | 'success' | 'failure';
export type MonitorFilter = 'all' | 'active' | 'attention';
export interface MonitorProject { id: string; name: string; path: string; issue?: string }
export interface MonitorRequest {
  id: string; projectId: string; runId: string; title: string; criticId: string;
  status: ReviewStatus; kind: CriticProfile['kind'];
  createdAt: string; startedAt: string | null; completedAt: string | null;
  claimedAt: string | null; claimedBy: string | null;
  activityAt: string; waitingReason: string | null;
  workerState: 'alive' | 'missing' | 'idle' | 'unknown';
  blockedByFailure: boolean;
}
export interface MonitorOverview {
  projects: MonitorProject[]; requests: MonitorRequest[]; total: number;
  counts: { all: number; active: number; attention: number };
  laneCounts: Record<MonitorLane, number>;
  hasMore: boolean; observedAt: string;
}
export interface MonitorSession { reviewerId: string; csrfToken: string }
export interface MonitorValidation { plan: ProjectPlan; observedAt: string }
export interface MonitorHumanState {
  canClaim: boolean; canComplete: boolean; claimedByMe: boolean;
  tryClaim?: { reviewerId: string; expiresAt: string; preparingByMe: boolean };
}
export interface MonitorHumanTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  artifactId: string; operation: string;
}
export interface MonitorToolResponse { result: unknown }
export interface MonitorDetail {
  request: MonitorRequest;
  instruction: string; profile: CriticProfile;
  result: { summary: string; evidence: string[] } | null;
  error: string | null;
  timeline: { label: string; at: string }[];
  artifacts: ArtifactReference[];
  artifactGroups?: ArtifactGroupReference[];
  artifactPreview?: 'legacy' | 'tools';
  human?: MonitorHumanState;
  tools?: MonitorHumanTool[];
  toolIssue?: string;
}
export interface MonitorArtifactPage {
  artifact: { id: string; path: string; directory: boolean; description: string };
  result: ArtifactCallResult;
}
export interface MonitorQuery { run?: string; lane?: MonitorLane; project?: string; filter?: MonitorFilter; limit?: number; offset?: number }
export interface MonitorSources { stateHome?: string; stateDirs?: string[] }

export interface MonitorRun {
  id: string; projectId: string; snapshotHash: string | null; status: RunStatus;
  createdAt: string; completedAt: string | null;
  scope: { kind: 'graph' | 'chain' | 'project' } | { kind: 'critic'; criticId: string } | null;
  graphAvailable: boolean;
}
export interface MonitorRunQuery { project?: string; limit?: number; offset?: number }
export interface MonitorRunOverview {
  projects: MonitorProject[]; runs: MonitorRun[]; total: number; hasMore: boolean; observedAt: string;
}
export interface MonitorGraph {
  project: MonitorProject; run: MonitorRun; available: boolean;
  unavailableReason: string | null; graph: GraphProjection | null;
  requests: MonitorRequest[]; observedAt: string;
}
