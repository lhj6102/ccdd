import type { ConfigManifest } from '../tools/contracts.js';
export type ArtifactOperation = 'read' | 'list';
export type ArtifactViewerKind = 'text' | 'files';
export type ArtifactAudience = 'agent' | 'human';
export interface BuiltinArtifactTool { description?: string }
export interface HumanCommandTool {
  description: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}
export type HumanArtifactToolConfig = BuiltinArtifactTool | HumanCommandTool;
export interface ArtifactTypeDefinition {
  viewer?: ArtifactViewerKind;
  /** Serialized marker for a type whose tools are in the recorded TS manifest. */
  custom?: true;
  tools?: Partial<Record<ArtifactOperation, { description: string }>>;
  agentTools?: Partial<Record<ArtifactOperation, BuiltinArtifactTool>>;
  humanTools?: Record<string, HumanArtifactToolConfig>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const operations: Record<ArtifactViewerKind, readonly ArtifactOperation[]> = { text: ['read'], files: ['list', 'read'] };
const defaults: Record<ArtifactOperation, string> = {
  read: 'Read text from {artifactName} using 1-based line ranges.',
  list: 'List files within {artifactName}.',
};

export function validateArtifactType(typeName: unknown, definition: unknown): ArtifactTypeDefinition {
  if (typeof typeName === 'string' && identifier.test(typeName) && object(definition) && definition.custom === true && Object.keys(definition).length === 1) return { custom: true };
  if (typeof typeName !== 'string' || !identifier.test(typeName) || !object(definition) ||
      (definition.viewer !== 'text' && definition.viewer !== 'files')) {
    throw new Error(`Invalid artifact type/viewer: ${String(typeName)}`);
  }
  for (const key of Object.keys(definition)) {
    if (!['viewer', 'tools', 'agentTools', 'humanTools'].includes(key)) throw new Error(`Unknown artifact type field: ${typeName}.${key}`);
  }
  for (const audience of ['tools', 'agentTools', 'humanTools'] as const) {
    if (!Object.hasOwn(definition, audience)) continue;
    const configured = definition[audience];
    if (!object(configured)) throw new Error(`Artifact type ${audience} must be an object: ${typeName}`);
    if (Object.keys(configured).length > 32) throw new Error(`Too many artifact tools: ${typeName}.${audience}`);
    for (const [operation, tool] of Object.entries(configured)) {
      if (!identifier.test(operation) || !object(tool)) throw new Error(`Invalid artifact tool: ${typeName}.${operation}`);
      const builtin = operation === 'read' || operation === 'list';
      if (builtin && !operations[definition.viewer].includes(operation)) {
        throw new Error(`Unsupported artifact tool for ${definition.viewer} viewer: ${typeName}.${operation}`);
      }
      if (!builtin && (audience !== 'humanTools' || !Object.hasOwn(tool, 'command'))) {
        throw new Error(`Unsupported artifact tool: ${typeName}.${operation}`);
      }
      if (builtin) {
        if (Object.keys(tool).some(key => key !== 'description')) throw new Error(`Artifact builtin tool allows only description: ${typeName}.${operation}`);
      } else {
        if (Object.keys(tool).some(key => !['description', 'command', 'args', 'timeoutMs'].includes(key))) throw new Error(`Unknown Human command field: ${typeName}.${operation}`);
        if (typeof tool.command !== 'string' || !tool.command.trim() || tool.command.length > 4096 || /[\0\r\n{}]/.test(tool.command) || (!tool.command.startsWith('/') && /[/\\]/.test(tool.command))) throw new Error(`Human command must be an executable name or absolute path: ${typeName}.${operation}`);
        if (!Array.isArray(tool.args) || tool.args.length > 64 || !tool.args.includes('{artifactPath}') || tool.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || (arg !== '{artifactPath}' && /[{}]/.test(arg)))) throw new Error(`Human command args must include standalone {artifactPath} and fixed string arguments: ${typeName}.${operation}`);
        if (tool.timeoutMs !== undefined && (typeof tool.timeoutMs !== 'number' || !Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 120_000)) throw new Error(`Human command timeoutMs must be 1–120000: ${typeName}.${operation}`);
      }
      if (tool.description === undefined && audience !== 'tools' && builtin) continue;
      if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 4000) throw new Error(`Artifact tool description must contain 1–4000 characters: ${typeName}.${operation}`);
      if (/[{}]/.test(tool.description.replaceAll('{artifactName}', ''))) throw new Error(`Artifact tool description supports only the {artifactName} placeholder: ${typeName}.${operation}`);
    }
  }
  return definition as unknown as ArtifactTypeDefinition;
}

/** Legacy defaults are available only if neither audience was explicitly declared. */
export function artifactAudienceTools(typeDefinition: ArtifactTypeDefinition, audience: ArtifactAudience, { allowLegacy = false }: { allowLegacy?: boolean } = {}): Record<string, HumanArtifactToolConfig> {
  const definition = validateArtifactType('artifact', typeDefinition);
  if (Object.hasOwn(definition, 'agentTools') || Object.hasOwn(definition, 'humanTools')) return structuredClone(definition[audience === 'agent' ? 'agentTools' : 'humanTools'] ?? {});
  if (!allowLegacy) return {};
  if (definition.custom) return {};
  return Object.fromEntries(operations[definition.viewer!].map(operation => [operation, { description: definition.tools?.[operation]?.description ?? defaults[operation] }]));
}

export function assertArtifactAudience(request: { profile: { kind: string }; artifacts: readonly { id: string; type: string }[]; artifactTypes: Readonly<Record<string, unknown>>;configManifest?:ConfigManifest }, { allowLegacy = false }: { allowLegacy?: boolean } = {}): void {
  const audience = request.profile.kind;
  if (audience !== 'agent' && audience !== 'human') return;
  for (const artifact of request.artifacts) {
    if(request.configManifest){
      if(!Object.keys(request.configManifest.types[artifact.type]?.[audience==='agent'?'agentTools':'humanTools']??{}).length)throw Object.assign(new Error(`Artifact ${artifact.id} has no ${audience} tools.`),{code:'ARTIFACT_TOOLS_UNAVAILABLE'});
      continue;
    }
    const type = validateArtifactType(artifact.type, request.artifactTypes[artifact.type]);
    if (!Object.keys(artifactAudienceTools(type, audience, { allowLegacy })).length) throw Object.assign(new Error(`Artifact ${artifact.id} has no ${audience} tools. Register ${audience}Tools on artifact type ${artifact.type}.`), { code: 'ARTIFACT_TOOLS_UNAVAILABLE' });
  }
}

export function toolDescription(typeDefinition: unknown, toolName: string, artifactName: unknown, audience?: ArtifactAudience): string {
  const definition = validateArtifactType('artifact', typeDefinition);
  if ((toolName !== 'read' && toolName !== 'list') || !definition.viewer || !operations[definition.viewer].includes(toolName)) {
    throw new Error(`Unsupported artifact tool for ${definition.viewer} viewer: ${String(toolName)}`);
  }
  if (typeof artifactName !== 'string' || !artifactName) throw new Error('Artifact name is required for its tool description.');
  const template = audience ? artifactAudienceTools(definition, audience, { allowLegacy: true })[toolName]?.description ?? defaults[toolName] : definition.tools?.[toolName]?.description ?? defaults[toolName];
  return template.replaceAll('{artifactName}', () => artifactName);
}
