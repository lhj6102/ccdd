import type { ArtifactReference, CriticProfile, ReviewStatus } from '../contracts.js';
import type { ArtifactCallResult } from '../artifacts/index.js';

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
  hasMore: boolean; observedAt: string;
}
export interface MonitorDetail {
  request: MonitorRequest;
  instruction: string; profile: CriticProfile;
  result: { summary: string; evidence: string[] } | null;
  error: string | null;
  timeline: { label: string; at: string }[];
  artifacts: ArtifactReference[];
}
export interface MonitorArtifactPage {
  artifact: { id: string; path: string; directory: boolean; description: string };
  result: ArtifactCallResult;
}
export interface MonitorQuery { project?: string; filter?: MonitorFilter; limit?: number; offset?: number }
export interface MonitorSources { stateHome?: string; stateDirs?: string[] }
