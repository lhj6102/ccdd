import type { ArtifactDefinition, ArtifactRelation } from '../definitions.js';
import type { ArtifactReference } from './index.js';

/** Composition grants input access, while instruction dependencies govern verification. */
export function resolveArtifactScope(artifacts: Record<string, ArtifactDefinition>, roots: readonly string[], copy = true): { artifacts: ArtifactReference[] } {
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const artifact = artifacts[id];
    if (!artifact) throw new Error(`Unknown Artifact: ${id}`);
    visited.add(id);
    for (const next of [...Object.values(artifact.children), ...Object.values(artifact.mounts)]) visit(next);
  };
  roots.forEach(visit);
  return { artifacts: [...visited].map(id => ({ id, ...(copy ? structuredClone(artifacts[id]) : artifacts[id]) })) };
}

/** A finite set of material and verification dependencies, including cycles. */
export function dependencyClosure(relations: readonly ArtifactRelation[], roots: readonly string[]): string[] {
  const result = new Set<string>(), pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const edge of relations) if (edge.target === id) pending.push(edge.source);
  }
  return [...result].sort();
}

export function artifactReferenceMetadata(artifacts: readonly ArtifactReference[]): { id: string; path: string }[] {
  return artifacts.map(({ id, path }) => ({ id, path }));
}
