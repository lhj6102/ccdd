import type { ArtifactEntryDefinition, ArtifactGroupDefinition, ArtifactGroupReference, ArtifactReference } from '../contracts.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isArtifactGroup(value: unknown): value is ArtifactGroupDefinition {
  return object(value) && value.kind === 'group';
}

/** Validate composition metadata without reading files or interpreting Critic dependencies. */
export function validateArtifactDefinitions(value: unknown): asserts value is Record<string, ArtifactEntryDefinition> {
  if (!object(value)) throw new Error('Artifact definitions must be an object.');
  for (const [id, artifact] of Object.entries(value)) {
    if (!identifier.test(id) || !object(artifact) || (artifact.basis !== undefined && typeof artifact.basis !== 'boolean')) {
      throw new Error(`Invalid Artifact definition: ${id}`);
    }
    if (isArtifactGroup(artifact)) {
      if (Object.hasOwn(artifact, 'type') || Object.hasOwn(artifact, 'path')) throw new Error(`Artifact group ${id} cannot declare type or path; reference independent Artifacts in members.`);
      if (!Array.isArray(artifact.members) || artifact.members.length === 0 || new Set(artifact.members).size !== artifact.members.length || artifact.members.some(member => typeof member !== 'string' || !identifier.test(member) || !Object.hasOwn(value, member))) {
        throw new Error(`Artifact group ${id} requires nonempty, unique, known members.`);
      }
    } else if (artifact.kind !== undefined || Object.hasOwn(artifact, 'members') || typeof artifact.type !== 'string' || !artifact.type || typeof artifact.path !== 'string' || !artifact.path) {
      throw new Error(`Invalid Artifact definition: ${id}`);
    }
  }
  const definitions = value as Record<string, ArtifactEntryDefinition>;
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Artifact group membership must be acyclic; cycle includes ${id}.`);
    if (visited.has(id)) return;
    const artifact = definitions[id];
    if (isArtifactGroup(artifact)) {
      visiting.add(id);
      for (const member of artifact.members) visit(member);
      visiting.delete(id);
    }
    visited.add(id);
  };
  for (const id of Object.keys(definitions)) visit(id);
}

/** Expand only explicitly selected entries and their members, in stable depth-first order. */
export function resolveArtifactScope(definitions: Record<string, ArtifactEntryDefinition>, ids: readonly string[]): { artifacts: ArtifactReference[]; artifactGroups?: ArtifactGroupReference[] } {
  validateArtifactDefinitions(definitions);
  const artifacts: ArtifactReference[] = [], artifactGroups: ArtifactGroupReference[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (!Object.hasOwn(definitions, id)) throw new Error(`Unknown Artifact in review scope: ${id}`);
    if (visited.has(id)) return;
    visited.add(id);
    const artifact = definitions[id];
    if (isArtifactGroup(artifact)) {
      artifactGroups.push({ id, members: [...artifact.members] });
      for (const member of artifact.members) visit(member);
    } else artifacts.push({ id, type: artifact.type, path: artifact.path });
  };
  for (const id of ids) visit(id);
  return { artifacts, ...(artifactGroups.length ? { artifactGroups } : {}) };
}
