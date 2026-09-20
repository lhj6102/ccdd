import { isDeepStrictEqual } from 'node:util';
import type { GeneratedArtifactDefinition, RepoConfig, ReviewEnvelope } from '../contracts.js';
import type { ArtifactSourceContext, ArtifactSourceDefinition, ArtifactSourceMetadata, PreparedArtifactData } from '../tools/contracts.js';
import { canonicalData, dataHash } from './data.js';
import { isGeneratedArtifact } from './groups.js';
import { openToolHost } from '../tools/host.js';
import { matchesToolManifest } from '../tools/manifest.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function sourceMetadata(value: unknown): ArtifactSourceMetadata {
  if (!object(value) || Object.keys(value).some(key => !['identity', 'preparation', 'timeoutMs'].includes(key)) || !['read-only', 'explicit'].includes(String(value.preparation))) throw new Error('Artifact sources require an explicit preparation policy.');
  const identity = value.identity;
  if (!object(identity) || Object.keys(identity).some(key => !['kind', 'namespace', 'version'].includes(key)) || !['canonical-data', 'immutable-revision', 'custom'].includes(String(identity.kind)) || !text(identity.namespace) || !text(identity.version)) throw new Error('Artifact identity requires a supported kind, namespace and version.');
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 900000)) throw new Error('Artifact source timeoutMs must be 1–900000.');
  return structuredClone(value) as unknown as ArtifactSourceMetadata;
}

/** One preparation binds the fingerprint and all possible observations to the same data. */
export async function captureArtifactData(source: ArtifactSourceDefinition, context: ArtifactSourceContext, purpose: 'inspect' | 'review'): Promise<PreparedArtifactData> {
  const metadata = sourceMetadata(source.metadata);
  if (purpose === 'inspect' && metadata.preparation !== 'read-only') throw Object.assign(new Error('This Artifact source requires explicit preparation through verification or tool diagnostics.'), { code: 'ARTIFACT_PREPARATION_REQUIRED' });
  context.signal.throwIfAborted();
  const result = await source.prepare(context);
  if (!object(result) || !Object.hasOwn(result, 'data') || Object.keys(result).some(key => !['data', 'revision'].includes(key))) throw new Error('Artifact preparation must return data and an optional immutable revision.');
  const data = JSON.parse(canonicalData(result.data));
  if (result.revision !== undefined && !text(result.revision, 4096)) throw new Error('An immutable revision must be a nonempty bounded string.');
  const contentHash = dataHash(data);
  let fingerprint = contentHash;
  if (metadata.identity.kind === 'immutable-revision') {
    if (!text(result.revision, 4096)) throw new Error('The immutable-revision strategy requires a source-scoped immutable revision.');
    fingerprint = dataHash(result.revision);
  } else if (metadata.identity.kind === 'custom') {
    if (!source.fingerprint) throw new Error('A custom identity strategy requires fingerprint(data).');
    const assertion = await source.fingerprint(structuredClone(data));
    if (!text(assertion, 4096)) throw new Error('A custom fingerprint must be a nonempty bounded string.');
    fingerprint = dataHash(assertion);
  }
  context.signal.throwIfAborted();
  return { version: 1, identity: { ...metadata.identity, fingerprint }, contentHash, data, ...(result.revision === undefined ? {} : { revision: result.revision }) };
}

/** Reopening verifies serialized material without invoking source or identity callbacks. */
export function assertPreparedArtifactData(input: unknown, metadata: ArtifactSourceMetadata): asserts input is PreparedArtifactData {
  const strategy = sourceMetadata(metadata).identity;
  if (!object(input) || input.version !== 1 || Object.keys(input).some(key => !['version', 'identity', 'contentHash', 'data', 'revision'].includes(key)) || !object(input.identity)) throw new Error('Missing or unsupported generated Artifact snapshot.');
  const { fingerprint, ...identity } = input.identity;
  if (!isDeepStrictEqual(identity, strategy) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || input.contentHash !== dataHash(input.data)) throw new Error('Generated Artifact snapshot identity or content integrity does not match.');
  if (input.revision !== undefined && !text(input.revision, 4096)) throw new Error('Invalid recorded immutable revision.');
  if (strategy.kind === 'canonical-data' && fingerprint !== input.contentHash || strategy.kind === 'immutable-revision' && (!text(input.revision, 4096) || fingerprint !== dataHash(input.revision))) throw new Error('Generated Artifact fingerprint does not match its recorded material.');
}

export function preparedArtifact(config: RepoConfig, id: string, definition: GeneratedArtifactDefinition): PreparedArtifactData {
  const metadata = config.configManifest?.sources?.[definition.source];
  if (!metadata) throw new Error(`Missing registered Artifact source: ${definition.source}`);
  const input = config.artifactInputs?.[id];
  assertPreparedArtifactData(input, metadata);
  return input;
}

export function assertGeneratedReviewInputs(request: Pick<ReviewEnvelope, 'artifacts' | 'configManifest'>): void {
  for (const artifact of request.artifacts) {
    if (artifact.kind !== 'generated') continue;
    const source = request.configManifest?.sources?.[artifact.source];
    if (!source) throw new Error('Missing recorded Artifact source.');
    assertPreparedArtifactData(artifact.input, source);
  }
}

/** Only explicit current-input operations enter this preparation seam. */
export async function prepareArtifactInputs(config: RepoConfig, root: string, purpose: 'inspect' | 'review', signal?: AbortSignal): Promise<RepoConfig> {
  const generated = Object.entries(config.artifacts).filter((entry): entry is [string, GeneratedArtifactDefinition] => isGeneratedArtifact(entry[1]));
  if (!generated.length) return config;
  const host = await openToolHost(root, signal);
  try {
    if (!config.configManifest || !matchesToolManifest(host.config, config.configManifest)) throw new Error('Artifact source definitions do not match the captured configuration.');
    const artifactInputs: Record<string, PreparedArtifactData> = {};
    for (const [id, definition] of generated) {
      signal?.throwIfAborted();
      const metadata = config.configManifest.sources?.[definition.source];
      if (!metadata) throw new Error(`Missing registered Artifact source: ${definition.source}`);
      if (purpose === 'inspect' && metadata.preparation !== 'read-only') throw Object.assign(new Error('This Artifact source requires explicit preparation through verification or tool diagnostics.'), { code: 'ARTIFACT_PREPARATION_REQUIRED' });
      const input = await host.call({ action: 'prepare-artifact', artifactId: id, purpose }, metadata.timeoutMs ?? 120000);
      assertPreparedArtifactData(input, metadata);
      artifactInputs[id] = input;
    }
    return { ...config, artifactInputs };
  } finally { await host.close(); }
}
