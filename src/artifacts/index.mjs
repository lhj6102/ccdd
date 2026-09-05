import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { toolDescription, validateArtifactType } from './types.mjs';

const MAX_READ_BYTES = 64 * 1024;
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 500;
const MAX_ENTRIES = 200;

function relativePath(value, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0') || value.includes('\\') || isAbsolute(value) || value.split('/').some(x => x === '..' || x === '.')) {
    throw new Error('Artifact path must be a safe repository-relative path');
  }
  return value;
}

function contained(root, candidate) {
  const sub = relative(root, candidate);
  return sub === '' || (!sub.startsWith(`..${sep}`) && sub !== '..' && !isAbsolute(sub));
}

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function argumentsObject(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Invalid artifact tool arguments');
}

async function withoutSymlinks(root, path) {
  let current = root;
  for (const component of path.split('/').filter(Boolean)) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Artifact paths must not contain symlinks or symlink escapes');
  }
  return realpath(current);
}

/** Stream complete LF/CRLF lines, preserving their original bytes and bounding retained content. */
async function readLines(file, size, startLine, requestedCount) {
  const output = [];
  let position = 0, currentLine = 1, currentBytes = 0, returnedBytes = 0, returnedLines = 0;
  let fragments = [];
  const result = (nextStartLine, totalLines) => {
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
    const bytes = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    if (!bytesRead) break;
    let cursor = 0;
    while (cursor < bytesRead) {
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
export async function createArtifactViewer({ worktreePath, artifacts, artifactTypes = {} }) {
  const worktree = await realpath(worktreePath);
  if (!Array.isArray(artifacts) || !artifacts.length) throw new Error('At least one artifact is required');
  const definitions = new Map();
  for (const artifact of artifacts) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(artifact.id ?? '') || definitions.has(artifact.id)) throw new Error('Invalid or duplicate artifact id');
    const declared = relativePath(artifact.path);
    const type = artifactTypes[artifact.type];
    if (!type) throw new Error(`Unsupported artifact type: ${artifact.type}`);
    validateArtifactType(artifact.type, type);
    const base = await withoutSymlinks(worktree, declared);
    if (!contained(worktree, base)) throw new Error('Artifact symlink escapes the snapshot');
    const info = await stat(base);
    if (!info.isDirectory() && !info.isFile()) throw new Error('Artifact must be a regular file or directory');
    if (type.viewer === 'text' && !info.isFile()) throw new Error('A text viewer requires a regular file artifact');
    definitions.set(artifact.id, { ...artifact, base, directory: info.isDirectory(), viewer: type.viewer, typeDefinition: type });
  }

  async function target(artifactId, path = '') {
    const artifact = definitions.get(artifactId);
    if (!artifact) throw new Error('Artifact is not in this review request');
    relativePath(path, { empty: true });
    if (!artifact.directory && path) throw new Error('A file artifact has no child paths');
    const currentBase = await withoutSymlinks(worktree, artifact.path);
    if (currentBase !== artifact.base) throw new Error('Artifact root changed since viewer creation');
    const candidate = artifact.directory ? await withoutSymlinks(artifact.base, path) : artifact.base;
    if (!contained(worktree, candidate) || !contained(artifact.base, candidate)) throw new Error('Requested path escapes the artifact');
    return { artifact, candidate, path: artifact.directory && path ? `${artifact.path}/${path}` : artifact.path };
  }

  const viewer = {
    listArtifacts() {
      return [...definitions.values()].map(({ id, type, path, viewer, directory, typeDefinition }) => ({ id, type, path, viewer, directory, toolDescriptions: Object.fromEntries((directory ? ['list', 'read'] : ['read']).map(operation => [operation, toolDescription(typeDefinition, operation, id)])) }));
    },
    async list(args) {
      argumentsObject(args, ['artifactId', 'path', 'offset', 'limit']);
      let { artifactId, path = '', offset = 0, limit = MAX_ENTRIES } = args;
      offset = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
      limit = integer(limit, MAX_ENTRIES, 1, MAX_ENTRIES, 'limit');
      const found = await target(artifactId, path);
      if (!(await stat(found.candidate)).isDirectory()) throw new Error('Listing requires a directory');
      const all = (await readdir(found.candidate, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const entries = all.slice(offset, offset + limit).map(x => ({
        name: x.name, path: path ? `${path}/${x.name}` : x.name,
        kind: x.isDirectory() ? 'directory' : x.isFile() ? 'file' : x.isSymbolicLink() ? 'symlink' : 'other',
      }));
      return { artifactId, path: found.path, type: found.artifact.type, entries, totalEntries: all.length, nextOffset: offset + entries.length < all.length ? offset + entries.length : null };
    },
    async read(args) {
      argumentsObject(args, ['artifactId', 'path', 'startLine', 'lineCount']);
      let { artifactId, path = '', startLine, lineCount } = args;
      startLine = integer(startLine, 1, 1, Number.MAX_SAFE_INTEGER, 'startLine');
      lineCount = integer(lineCount, DEFAULT_READ_LINES, 1, MAX_READ_LINES, 'lineCount');
      const artifact = definitions.get(artifactId);
      if (!artifact) throw new Error('Artifact is not in this review request');
      if (artifact.directory && (!Object.hasOwn(args, 'path') || typeof path !== 'string' || !path)) throw new Error('Reading a directory artifact requires an internal file path');
      if (!artifact.directory && Object.hasOwn(args, 'path')) throw new Error('A file artifact read does not accept path');
      const found = await target(artifactId, path);
      if (!(await stat(found.candidate)).isFile()) throw new Error('Reading requires a regular file; list the directory first');
      const file = await open(found.candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error('Reading requires a regular file; list the directory first');
        return { artifactId, path: found.path, type: found.artifact.type, ...await readLines(file, info.size, startLine, lineCount) };
      } finally { await file.close(); }
    },
  };
  return viewer;
}

/** Viewer adapter: file is relative to a directory artifact, never the repo root. */
export async function readArtifact({ worktreePath, artifacts, artifactTypes, artifactId, file = '', offset, limit, startLine, lineCount }) {
  if (typeof file !== 'string') throw new Error('Artifact file must be an internal relative path string');
  const viewer = await createArtifactViewer({ worktreePath, artifacts, artifactTypes });
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
export function createArtifactTools(viewer) {
  const handlers = new Map();
  const tools = [];
  for (const artifact of viewer.listArtifacts()) {
    for (const operation of artifact.directory ? ['list', 'read'] : ['read']) {
      const name = `${operation}_${artifact.id}`;
      const properties = {
        ...(artifact.directory ? { path: { type: 'string', ...(operation === 'read' ? { minLength: 1 } : {}), description: operation === 'read' ? 'Required file path inside this artifact, relative to its root.' : 'Directory path inside this artifact. Omit or use an empty string to list its root.' } } : {}),
        ...(operation === 'read' ? {
          startLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1, description: 'First line to read, numbered from 1.' },
          lineCount: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, default: DEFAULT_READ_LINES, description: `Maximum complete lines to read, preserving original line endings and bounded to ${MAX_READ_BYTES} UTF-8 bytes per response. An oversized single line is an error. Follow nextStartLine to continue when truncated.` },
        } : {
          offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: 'Entry offset for pagination.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, default: MAX_ENTRIES },
        }),
      };
      tools.push({ name, description: artifact.toolDescriptions[operation], inputSchema: { type: 'object', properties, ...(artifact.directory && operation === 'read' ? { required: ['path'] } : {}), additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
      handlers.set(name, async args => {
        argumentsObject(args, Object.keys(properties));
        return viewer[operation]({ ...args, artifactId: artifact.id });
      });
    }
  }
  return {
    tools,
    async call(name, args = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error('Unknown artifact tool');
      return handler(args);
    },
  };
}
