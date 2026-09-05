import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { artifactAudienceTools, toolDescription, validateArtifactType } from './types.js';

import type { ArtifactAudience, ArtifactOperation, ArtifactTypeDefinition, ArtifactViewerKind } from './types.js';
export type { ArtifactAudience, ArtifactOperation, ArtifactTypeDefinition, ArtifactViewerKind } from './types.js';
export { assertArtifactAudience } from './types.js';

export interface ArtifactReference { id: string; type: string; path: string }
export interface ArtifactViewerOptions {
  worktreePath: string;
  artifacts: readonly ArtifactReference[];
  artifactTypes?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}
export interface ArtifactDescriptor extends ArtifactReference {
  viewer: ArtifactViewerKind;
  directory: boolean;
  toolDescriptions: Partial<Record<ArtifactOperation, string>>;
}
interface ArtifactDefinition extends ArtifactReference {
  base: string;
  directory: boolean;
  viewer: ArtifactViewerKind;
  typeDefinition: ArtifactTypeDefinition;
}
export interface LineReadResult {
  content: string;
  startLine: number;
  endLine: number | null;
  lineCount: number;
  totalLines?: number;
  truncated: boolean;
  nextStartLine: number | null;
}
export interface ArtifactReadResult extends LineReadResult {
  artifactId: string;
  path: string;
  type: string;
  directory?: false;
}
export interface ArtifactEntry { name: string; path: string; kind: 'directory' | 'file' | 'symlink' | 'other' }
export interface ArtifactListResult {
  artifactId: string;
  path: string;
  type: string;
  entries: ArtifactEntry[];
  totalEntries: number;
  nextOffset: number | null;
}
export interface ArtifactDirectoryResult extends ArtifactListResult { content: string; directory: true }
export type ArtifactCallResult = ArtifactReadResult | ArtifactListResult;
export interface ArtifactReadArguments { artifactId: string; path?: string; startLine?: number; lineCount?: number }
export interface ArtifactListArguments { artifactId: string; path?: string; offset?: number; limit?: number }
export interface ArtifactViewer {
  readonly signal?: AbortSignal;
  listArtifacts(): ArtifactDescriptor[];
  getTypeDefinition(artifactId: string): ArtifactTypeDefinition;
  /** Internal runner capability; never exported as an Agent tool. */
  resolveTarget(artifactId: string, path?: string): Promise<{ absolutePath: string; directory: boolean }>;
  list(args: unknown): Promise<ArtifactListResult>;
  read(args: unknown): Promise<ArtifactReadResult>;
}
export interface ReadArtifactOptions extends ArtifactViewerOptions {
  artifactId: string;
  file?: unknown;
  offset?: unknown;
  limit?: unknown;
  startLine?: unknown;
  lineCount?: unknown;
}
export interface ArtifactSchemaProperty {
  type: 'string' | 'integer';
  description?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  default?: number;
}
export interface ArtifactToolDefinition {
  artifactId?: string;
  operation?: ArtifactOperation;
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, ArtifactSchemaProperty>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}
export interface ArtifactTools {
  tools: ArtifactToolDefinition[];
  validateArguments(name: string, args: unknown): Record<string, unknown>;
  call(name: `read_${string}`, args?: unknown): Promise<ArtifactReadResult>;
  call(name: `list_${string}`, args?: unknown): Promise<ArtifactListResult>;
  call(name: string, args?: unknown): Promise<ArtifactCallResult>;
}
export interface ArtifactObservation {
  artifactId: string;
  operation: ArtifactOperation;
  startLine?: number;
  endLine?: number | null;
  lineCount?: number;
  totalLines?: number;
}
export interface ArtifactToolCall {
  name: string;
  arguments: Record<string, unknown>;
  observation: ArtifactObservation;
  at: string;
}
export interface AuditedArtifactTools extends ArtifactTools { readonly toolCalls: ArtifactToolCall[] }
export interface ArtifactAuditOptions { onCall?: (call: ArtifactToolCall) => void | Promise<void> }

function artifactIdentifier(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Artifact is not in this review request');
  return value;
}

const MAX_READ_BYTES = 64 * 1024;
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 500;
const MAX_ENTRIES = 200;

function relativePath(value: unknown, { empty = false }: { empty?: boolean } = {}): string {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0') || value.includes('\\') || isAbsolute(value) || value.split('/').some(x => x === '..' || x === '.')) {
    throw new Error('Artifact path must be a safe repository-relative path');
  }
  return value;
}

function contained(root: string, candidate: string): boolean {
  const sub = relative(root, candidate);
  return sub === '' || (!sub.startsWith(`..${sep}`) && sub !== '..' && !isAbsolute(sub));
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function argumentsObject(args: unknown, allowed: readonly string[]): asserts args is Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Invalid artifact tool arguments');
}

async function withoutSymlinks(root: string, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let current = root;
  for (const component of path.split('/').filter(Boolean)) {
    signal?.throwIfAborted();
    current = resolve(current, component);
    const info = await lstat(current);
    signal?.throwIfAborted();
    if (info.isSymbolicLink()) throw new Error('Artifact paths must not contain symlinks or symlink escapes');
  }
  signal?.throwIfAborted();
  const pathResult = await realpath(current);
  signal?.throwIfAborted();
  return pathResult;
}

/** Stream complete LF/CRLF lines, preserving their original bytes and bounding retained content. */
async function readLines(file: FileHandle, size: number, startLine: number, requestedCount: number, signal?: AbortSignal): Promise<LineReadResult> {
  const output: Buffer[] = [];
  let position = 0, currentLine = 1, currentBytes = 0, returnedBytes = 0, returnedLines = 0;
  let fragments: Buffer[] = [];
  const result = (nextStartLine: number | null, totalLines?: number): LineReadResult => {
    signal?.throwIfAborted();
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(output, returnedBytes)); }
    catch { throw new Error(`Artifact contains invalid UTF-8 text in the requested lines starting at ${startLine}`); }
    return {
      content, startLine, endLine: returnedLines ? startLine + returnedLines - 1 : null, lineCount: returnedLines,
      ...(totalLines === undefined ? {} : { totalLines }),
      truncated: nextStartLine !== null, nextStartLine,
    };
  };
  for (;;) {
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    signal?.throwIfAborted();
    if (!bytesRead) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      signal?.throwIfAborted();
      const newline = bytes.subarray(0, bytesRead).indexOf(10, cursor);
      const end = newline === -1 ? bytesRead : newline + 1;
      const fragment = bytes.subarray(cursor, end);
      if (currentLine >= startLine) {
        if (currentBytes + fragment.length > MAX_READ_BYTES - returnedBytes) {
          if (returnedLines) return result(currentLine);
          throw new Error(`Artifact line ${currentLine} exceeds the ${MAX_READ_BYTES}-byte read limit; use a viewer that supports oversized lines`);
        }
        if (fragment.includes(0)) throw new Error('Binary artifacts require a different viewer');
        fragments.push(fragment);
      }
      currentBytes += fragment.length;
      if (newline !== -1) {
        if (currentLine >= startLine) {
          output.push(...fragments);
          returnedBytes += currentBytes;
          returnedLines++;
          fragments = [];
          if (returnedLines === requestedCount || returnedBytes === MAX_READ_BYTES) {
            const more = position + end < size;
            return result(more ? currentLine + 1 : null, more ? undefined : currentLine);
          }
        }
        currentLine++;
        currentBytes = 0;
      }
      cursor = end;
    }
    position += bytesRead;
  }
  if (currentBytes && currentLine >= startLine) {
    output.push(...fragments);
    returnedBytes += currentBytes;
    returnedLines++;
  }
  return result(null, currentLine - 1 + (currentBytes ? 1 : 0));
}

/** Resolve only declared artifacts inside the prepared input. No writes or shell entry points. */
export async function createArtifactViewer({ worktreePath, artifacts, artifactTypes = {}, signal }: ArtifactViewerOptions): Promise<ArtifactViewer> {
  signal?.throwIfAborted();
  const worktree = await realpath(worktreePath);
  signal?.throwIfAborted();
  if (!Array.isArray(artifacts) || !artifacts.length) throw new Error('At least one artifact is required');
  const definitions = new Map<string, ArtifactDefinition>();
  for (const artifact of artifacts) {
    signal?.throwIfAborted();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(artifact.id ?? '') || definitions.has(artifact.id)) throw new Error('Invalid or duplicate artifact id');
    const declared = relativePath(artifact.path);
    const configuredType = artifactTypes[artifact.type];
    if (!configuredType) throw new Error(`Unsupported artifact type: ${artifact.type}`);
    const type = structuredClone(validateArtifactType(artifact.type, configuredType));
    const base = await withoutSymlinks(worktree, declared, signal);
    if (!contained(worktree, base)) throw new Error('Artifact symlink escapes the snapshot');
    signal?.throwIfAborted();
    const info = await stat(base);
    signal?.throwIfAborted();
    if (!info.isDirectory() && !info.isFile()) throw new Error('Artifact must be a regular file or directory');
    if (type.viewer === 'text' && !info.isFile()) throw new Error('A text viewer requires a regular file artifact');
    definitions.set(artifact.id, { ...artifact, base, directory: info.isDirectory(), viewer: type.viewer, typeDefinition: type });
  }

  async function target(artifactId: string, path = '') {
    signal?.throwIfAborted();
    const artifact = definitions.get(artifactId);
    if (!artifact) throw new Error('Artifact is not in this review request');
    relativePath(path, { empty: true });
    if (!artifact.directory && path) throw new Error('A file artifact has no child paths');
    const currentBase = await withoutSymlinks(worktree, artifact.path, signal);
    if (currentBase !== artifact.base) throw new Error('Artifact root changed since viewer creation');
    const candidate = artifact.directory ? await withoutSymlinks(artifact.base, path, signal) : artifact.base;
    if (!contained(worktree, candidate) || !contained(artifact.base, candidate)) throw new Error('Requested path escapes the artifact');
    return { artifact, candidate, path: artifact.directory && path ? `${artifact.path}/${path}` : artifact.path };
  }

  const viewer: ArtifactViewer = {
    signal,
    listArtifacts() {
      signal?.throwIfAborted();
      return [...definitions.values()].map(({ id, type, path, viewer, directory, typeDefinition }) => ({ id, type, path, viewer, directory, toolDescriptions: Object.fromEntries((directory ? ['list', 'read'] as const : ['read'] as const).map(operation => [operation, toolDescription(typeDefinition, operation, id, 'agent')])) }));
    },
    getTypeDefinition(artifactId) {
      signal?.throwIfAborted();
      const artifact = definitions.get(artifactId);
      if (!artifact) throw new Error('Artifact is not in this review request');
      return structuredClone(artifact.typeDefinition);
    },
    async resolveTarget(artifactId, path = '') {
      const found = await target(artifactId, path);
      const info = await stat(found.candidate);
      signal?.throwIfAborted();
      if (!info.isDirectory() && !info.isFile()) throw new Error('Artifact target must be a regular file or directory');
      return { absolutePath: found.candidate, directory: info.isDirectory() };
    },
    async list(args: unknown) {
      signal?.throwIfAborted();
      argumentsObject(args, ['artifactId', 'path', 'offset', 'limit']);
      const artifactId = artifactIdentifier(args.artifactId);
      const path = relativePath(args.path === undefined ? '' : args.path, { empty: true });
      const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
      const limit = integer(args.limit, MAX_ENTRIES, 1, MAX_ENTRIES, 'limit');
      const found = await target(artifactId, relativePath(path, { empty: true }));
      signal?.throwIfAborted();
      const info = await stat(found.candidate);
      signal?.throwIfAborted();
      if (!info.isDirectory()) throw new Error('Listing requires a directory');
      const all = await readdir(found.candidate, { withFileTypes: true });
      signal?.throwIfAborted();
      all.sort((a, b) => a.name.localeCompare(b.name));
      const entries: ArtifactEntry[] = all.slice(offset, offset + limit).map(x => ({
        name: x.name, path: path ? `${path}/${x.name}` : x.name,
        kind: x.isDirectory() ? 'directory' : x.isFile() ? 'file' : x.isSymbolicLink() ? 'symlink' : 'other',
      }));
      signal?.throwIfAborted();
      return { artifactId, path: found.path, type: found.artifact.type, entries, totalEntries: all.length, nextOffset: offset + entries.length < all.length ? offset + entries.length : null };
    },
    async read(args: unknown) {
      signal?.throwIfAborted();
      argumentsObject(args, ['artifactId', 'path', 'startLine', 'lineCount']);
      const artifactId = artifactIdentifier(args.artifactId);
      const path = args.path === undefined ? '' : args.path;
      const startLine = integer(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER, 'startLine');
      const lineCount = integer(args.lineCount, DEFAULT_READ_LINES, 1, MAX_READ_LINES, 'lineCount');
      const artifact = definitions.get(artifactId);
      if (!artifact) throw new Error('Artifact is not in this review request');
      if (artifact.directory && (!Object.hasOwn(args, 'path') || typeof path !== 'string' || !path)) throw new Error('Reading a directory artifact requires an internal file path');
      if (!artifact.directory && Object.hasOwn(args, 'path')) throw new Error('A file artifact read does not accept path');
      const found = await target(artifactId, relativePath(path, { empty: true }));
      signal?.throwIfAborted();
      const entry = await stat(found.candidate);
      signal?.throwIfAborted();
      if (!entry.isFile()) throw new Error('Reading requires a regular file; list the directory first');
      const file = await open(found.candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        signal?.throwIfAborted();
        const info = await file.stat();
        signal?.throwIfAborted();
        if (!info.isFile()) throw new Error('Reading requires a regular file; list the directory first');
        return { artifactId, path: found.path, type: found.artifact.type, ...await readLines(file, info.size, startLine, lineCount, signal) };
      } finally { await file.close(); }
    },
  };
  return viewer;
}

/** Viewer adapter: file is relative to a directory artifact, never the repo root. */
export async function readArtifact({ worktreePath, artifacts, artifactTypes, signal, artifactId, file = '', offset, limit, startLine, lineCount }: ReadArtifactOptions): Promise<ArtifactReadResult | ArtifactDirectoryResult> {
  if (typeof file !== 'string') throw new Error('Artifact file must be an internal relative path string');
  const viewer = await createArtifactViewer({ worktreePath, artifacts, artifactTypes, signal });
  const artifact = viewer.listArtifacts().find(x => x.id === artifactId);
  if (!artifact) throw new Error('Artifact is not in this review request');
  if (artifact.directory && !file) {
    if (startLine !== undefined || lineCount !== undefined) throw new Error('Directory listing does not accept startLine or lineCount');
    const result = await viewer.list({ artifactId, offset, limit });
    return { ...result, content: result.entries.map(x => `${x.kind === 'directory' ? '▸' : '·'} ${x.path}`).join('\n'), directory: true };
  }
  if (offset !== undefined || limit !== undefined) throw new Error('Reading uses startLine and lineCount, not offset or limit');
  if (!artifact.directory && file) throw new Error('A file artifact read does not accept an internal file path');
  return viewer.read({ artifactId, ...(artifact.directory ? { path: file } : {}), startLine, lineCount });
}

/** Each request receives concrete viewer entry points for its own declared artifacts. */
export function createArtifactTools(viewer: ArtifactViewer, { audience = 'agent', allowLegacy = true }: { audience?: ArtifactAudience | 'viewer'; allowLegacy?: boolean } = {}): ArtifactTools {
  const handlers = new Map<string, (args: unknown) => Promise<ArtifactCallResult>>();
  const tools: ArtifactToolDefinition[] = [];
  for (const artifact of viewer.listArtifacts()) {
    const typeDefinition = viewer.getTypeDefinition(artifact.id);
    const configured = audience === 'viewer' ? { read: {}, list: {} } : artifactAudienceTools(typeDefinition, audience, { allowLegacy });
    for (const operation of artifact.directory ? ['list', 'read'] as const : ['read'] as const) {
      if (!Object.hasOwn(configured, operation)) continue;
      const name = `${operation}_${artifact.id}`;
      const properties: Record<string, ArtifactSchemaProperty> = {
        ...(artifact.directory ? { path: { type: 'string', ...(operation === 'read' ? { minLength: 1 } : {}), description: operation === 'read' ? 'Required file path inside this artifact, relative to its root.' : 'Directory path inside this artifact. Omit or use an empty string to list its root.' } } : {}),
        ...(operation === 'read' ? {
          startLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1, description: 'First line to read, numbered from 1.' },
          lineCount: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, default: DEFAULT_READ_LINES, description: `Maximum complete lines to read, preserving original line endings and bounded to ${MAX_READ_BYTES} UTF-8 bytes per response. An oversized single line is an error. Follow nextStartLine to continue when truncated.` },
        } : {
          offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: 'Entry offset for pagination.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, default: MAX_ENTRIES },
        }),
      };
      tools.push({ artifactId: artifact.id, operation, name, description: toolDescription(typeDefinition, operation, artifact.id, audience === 'viewer' ? undefined : audience), inputSchema: { type: 'object', properties, ...(artifact.directory && operation === 'read' ? { required: ['path'] } : {}), additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
      handlers.set(name, async args => {
        argumentsObject(args, Object.keys(properties));
        return viewer[operation]({ ...args, artifactId: artifact.id });
      });
    }
  }
  function validateArguments(name: string, args: unknown): Record<string, unknown> {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error('Unknown artifact tool');
    return validateToolArguments(tool.inputSchema, args);
  }
  async function call(name: `read_${string}`, args?: unknown): Promise<ArtifactReadResult>;
  async function call(name: `list_${string}`, args?: unknown): Promise<ArtifactListResult>;
  async function call(name: string, args?: unknown): Promise<ArtifactCallResult>;
  async function call(name: string, args: unknown = {}): Promise<ArtifactCallResult> {
    const handler = handlers.get(name);
    if (!handler) throw new Error('Unknown artifact tool');
    viewer.signal?.throwIfAborted();
    const result = await handler(validateArguments(name, args));
    viewer.signal?.throwIfAborted();
    return result;
  }
  return { tools, call, validateArguments };
}

export function validateToolArguments(schema: ArtifactToolDefinition['inputSchema'], args: unknown): Record<string, unknown> {
  argumentsObject(args, Object.keys(schema.properties));
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) throw new Error(`Missing required artifact tool argument: ${name}`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = args[name];
    if (value === undefined) continue;
    if (property.type === 'string') {
      if (typeof value !== 'string' || (property.minLength !== undefined && value.length < property.minLength)) throw new Error(`Invalid ${name}`);
    } else {
      integer(value, property.default ?? 0, property.minimum ?? Number.MIN_SAFE_INTEGER, property.maximum ?? Number.MAX_SAFE_INTEGER, name);
    }
  }
  return { ...args };
}

/** Record the same successful observations for MCP and direct provider adapters. */
export function createAuditedArtifactTools(viewer: ArtifactViewer, { onCall }: ArtifactAuditOptions = {}): AuditedArtifactTools {
  const registry = createArtifactTools(viewer);
  const calls: ArtifactToolCall[] = [];
  async function call(name: `read_${string}`, args?: unknown): Promise<ArtifactReadResult>;
  async function call(name: `list_${string}`, args?: unknown): Promise<ArtifactListResult>;
  async function call(name: string, args?: unknown): Promise<ArtifactCallResult>;
  async function call(name: string, args: unknown = {}): Promise<ArtifactCallResult> {
    // Clone before awaiting so caller mutations cannot alter the audited arguments.
    const actualArgs = structuredClone(registry.validateArguments(name, args));
    const data = await registry.call(name, actualArgs);
    viewer.signal?.throwIfAborted();
    const observation: ArtifactObservation = 'entries' in data
      ? { artifactId: data.artifactId, operation: 'list' }
      : { artifactId: data.artifactId, operation: 'read', startLine: data.startLine, endLine: data.endLine, lineCount: data.lineCount, ...(data.totalLines === undefined ? {} : { totalLines: data.totalLines }) };
    const entry: ArtifactToolCall = { name, arguments: actualArgs, observation, at: new Date().toISOString() };
    // A persistence callback must succeed before the adapter returns a successful call.
    await onCall?.(structuredClone(entry));
    viewer.signal?.throwIfAborted();
    calls.push(entry);
    return data;
  }
  return { tools: registry.tools, call, validateArguments: registry.validateArguments, get toolCalls() { return structuredClone(calls); } };
}
