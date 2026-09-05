export type ArtifactOperation = 'read' | 'list';
export type ArtifactViewerKind = 'text' | 'files';
export interface ArtifactTypeDefinition {
  viewer: ArtifactViewerKind;
  tools?: Partial<Record<ArtifactOperation, { description: string }>>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const operations: Record<ArtifactViewerKind, readonly ArtifactOperation[]> = { text: ['read'], files: ['list', 'read'] };
const defaults: Record<ArtifactOperation, string> = {
  read: 'Read text from {artifactName} using 1-based line ranges.',
  list: 'List files within {artifactName}.',
};

export function validateArtifactType(typeName: unknown, definition: unknown): ArtifactTypeDefinition {
  if (typeof typeName !== 'string' || !identifier.test(typeName) || !object(definition) ||
      (definition.viewer !== 'text' && definition.viewer !== 'files')) {
    throw new Error(`Invalid artifact type/viewer: ${String(typeName)}`);
  }
  for (const key of Object.keys(definition)) {
    if (!['viewer', 'tools'].includes(key)) throw new Error(`Unknown artifact type field: ${typeName}.${key}`);
  }
  if (!Object.hasOwn(definition, 'tools')) return definition as unknown as ArtifactTypeDefinition;
  if (!object(definition.tools)) throw new Error(`Artifact type tools must be an object: ${typeName}`);
  for (const [operation, tool] of Object.entries(definition.tools)) {
    if (!operations[definition.viewer].some(candidate => candidate === operation)) {
      throw new Error(`Unsupported artifact tool for ${definition.viewer} viewer: ${typeName}.${operation}`);
    }
    if (!object(tool) || Object.keys(tool).some(key => key !== 'description')) {
      throw new Error(`Artifact tool requires only a description field: ${typeName}.${operation}`);
    }
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 4000) {
      throw new Error(`Artifact tool description must contain 1–4000 characters: ${typeName}.${operation}`);
    }
    if (/[{}]/.test(tool.description.replaceAll('{artifactName}', ''))) {
      throw new Error(`Artifact tool description supports only the {artifactName} placeholder: ${typeName}.${operation}`);
    }
  }
  return definition as unknown as ArtifactTypeDefinition;
}

export function toolDescription(typeDefinition: unknown, toolName: string, artifactName: unknown): string {
  const definition = validateArtifactType('artifact', typeDefinition);
  if ((toolName !== 'read' && toolName !== 'list') || !operations[definition.viewer].includes(toolName)) {
    throw new Error(`Unsupported artifact tool for ${definition.viewer} viewer: ${String(toolName)}`);
  }
  if (typeof artifactName !== 'string' || !artifactName) throw new Error('Artifact name is required for its tool description.');
  const template = definition.tools?.[toolName]?.description ?? defaults[toolName];
  return template.replaceAll('{artifactName}', () => artifactName);
}
