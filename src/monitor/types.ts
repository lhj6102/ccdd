import type { ArtifactReference, CriticProfile, ReviewStatus } from '../contracts.js';
import type { ArtifactCallResult } from '../artifacts/index.js';

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
export interface MonitorHumanState { canClaim: boolean; canComplete: boolean; claimedByMe: boolean }
export interface MonitorHumanTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  artifactId: string; operation: 'read' | 'list' | 'command';
}
export interface MonitorToolResponse { result: unknown }
export interface MonitorDetail {
  request: MonitorRequest;
  instruction: string; profile: CriticProfile;
  result: { summary: string; evidence: string[] } | null;
  error: string | null;
  timeline: { label: string; at: string }[];
  artifacts: ArtifactReference[];
  human?: MonitorHumanState;
  tools?: MonitorHumanTool[];
  toolIssue?: string;
}
export interface MonitorArtifactPage {
  artifact: { id: string; path: string; directory: boolean; description: string };
  result: ArtifactCallResult;
}
export interface MonitorQuery { lane?: MonitorLane; project?: string; filter?: MonitorFilter; limit?: number; offset?: number }
export interface MonitorSources { stateHome?: string; stateDirs?: string[] }
