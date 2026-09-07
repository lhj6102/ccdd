import { projectGraph, type GraphDefinition, type GraphProjection, type GraphRequest, type ArtifactStatus } from '../broker/graph.js';
import type { ProjectPlan, ValidationStatus } from './types.js';
import type { ReviewStatus } from '../contracts.js';

const reviewStatus = (status: ValidationStatus): ReviewStatus | null => status === 'PASS' ? 'GREEN' : status === 'STALE' || status === 'UNREVIEWED' || status === 'BASIS' ? null : status;
/** Explicit projections may refer to actual earlier evidence, never fabricated tickets. */
export function projectValidationGraph(graph: GraphDefinition, plan: ProjectPlan, requests: GraphRequest[], runId: string): GraphProjection {
  const projection = projectGraph(graph, requests);
  for (const critic of projection.critics) {
    const value = plan.critics.find(c => c.id === critic.id)!;
    const reused = value.status === 'PASS' && value.result && value.result.runId !== runId;
    critic.validationStatus = value.status; critic.validationReason = value.reason;
    critic.status = reviewStatus(value.status);
    critic.requestId = value.requestId ?? value.result?.requestId ?? null;
    critic.blockedReason = value.blockedBy.length ? value.reason : null;
    if (reused) critic.reusedFrom = { requestId: value.result!.requestId, runId: value.result!.runId, completedAt: value.result!.completedAt };
  }
  for (const artifact of projection.artifacts) {
    const value = plan.artifacts.find(a => a.id === artifact.id)!;
    artifact.validationStatus = value.status;
    artifact.status = (value.status === 'BASIS' ? 'BASIS' : reviewStatus(value.status) ?? 'UNREVIEWED') as ArtifactStatus;
    artifact.passed = value.passed;
    artifact.included = value.criticIds.filter(id => plan.includedCriticIds.includes(id)).length;
  }
  return projection;
}
