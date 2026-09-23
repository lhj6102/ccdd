import type { ArtifactReference } from './index.js';
export type ArtifactAudience = 'agent' | 'human';
export function assertArtifactAudience(request: { profile: { kind: string }; artifacts: readonly ArtifactReference[]; requiredObservations?: readonly string[] }): void {
  const audience = request.profile.kind;
  if (audience !== 'agent' && audience !== 'human') return;
  const required = new Set(request.requiredObservations ?? request.artifacts.map(a => a.id));
  for (const artifact of request.artifacts) {
    if (!required.has(artifact.id)) continue;
    if (!Object.keys(artifact.views[audience === 'agent' ? 'agentTools' : 'humanTools'] ?? {}).length) throw Object.assign(new Error(`Artifact ${artifact.id} has no ${audience} views.`), { code: 'ARTIFACT_TOOLS_UNAVAILABLE' });
  }
}
