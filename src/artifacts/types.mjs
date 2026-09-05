const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const operations = { text: ['read'], files: ['list', 'read'] };
const defaults = {
  read: 'Read text from {artifactName} using 1-based line ranges.',
  list: 'List files within {artifactName}.',
};

export function validateArtifactType(typeName, definition) {
  if (typeof typeName !== 'string' || !identifier.test(typeName) || !object(definition) ||
      !['text', 'files'].includes(definition.viewer)) {
    throw new Error(`Invalid artifact type/viewer: ${String(typeName)}`);
  }
  for (const key of Object.keys(definition)) {
    if (!['viewer', 'tools'].includes(key)) throw new Error(`Unknown artifact type field: ${typeName}.${key}`);
  }
  if (!Object.hasOwn(definition, 'tools')) return definition;
  if (!object(definition.tools)) throw new Error(`Artifact type tools must be an object: ${typeName}`);
  for (const [operation, tool] of Object.entries(definition.tools)) {
    if (!operations[definition.viewer].includes(operation)) {
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
  return definition;
}

export function toolDescription(typeDefinition, toolName, artifactName) {
  validateArtifactType('artifact', typeDefinition);
  if (!operations[typeDefinition.viewer].includes(toolName)) {
    throw new Error(`Unsupported artifact tool for ${typeDefinition.viewer} viewer: ${String(toolName)}`);
  }
  if (typeof artifactName !== 'string' || !artifactName) throw new Error('Artifact name is required for its tool description.');
  const template = typeDefinition.tools?.[toolName]?.description ?? defaults[toolName];
  return template.replaceAll('{artifactName}', () => artifactName);
}
