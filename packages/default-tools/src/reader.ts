import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_READ_BYTES = 64 * 1024;

export interface LineReadResult {
  content: string;
  startLine: number;
  endLine: number | null;
  lineCount: number;
  totalLines?: number;
  truncated: boolean;
  nextStartLine: number | null;
}

export function objectArguments(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Invalid artifact tool arguments');
  return args as Record<string, unknown>;
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function internalPath(value: unknown = ''): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || isAbsolute(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('Artifact path must be a safe internal relative path');
  return value;
}

export async function scopedTarget(root: string, directory: boolean, path: string): Promise<string> {
  if (!isAbsolute(root) || (await lstat(root)).isSymbolicLink()) throw new Error('Artifact root must be an absolute non-symlink path');
  const base = await realpath(root);
  const info = await stat(base);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('Artifact shape changed');
  if (!directory && path) throw new Error('A file artifact has no child paths');
  let candidate = base;
  for (const part of path.split('/').filter(Boolean)) {
    candidate = resolve(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('Artifact paths must not contain symlinks');
  }
  candidate = await realpath(candidate);
  const sub = relative(base, candidate);
  if (sub === '..' || sub.startsWith(`..${sep}`) || isAbsolute(sub)) throw new Error('Requested path escapes the artifact');
  return candidate;
}

/** Stream original LF/CRLF bytes. Skip preceding lines without retaining them or decoding unrelated content. */
async function readLines(file: FileHandle, size: number, startLine: number, requestedCount: number): Promise<LineReadResult> {
  const output: Buffer[] = [];
  let position = 0, currentLine = 1, currentBytes = 0, returnedBytes = 0, returnedLines = 0;
  let fragments: Buffer[] = [];
  const result = (nextStartLine: number | null, totalLines?: number): LineReadResult => {
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(output, returnedBytes)); }
    catch { throw new Error(`Artifact contains invalid UTF-8 text in the requested lines starting at ${startLine}`); }
    return { content, startLine, endLine: returnedLines ? startLine + returnedLines - 1 : null, lineCount: returnedLines,
      ...(totalLines === undefined ? {} : { totalLines }), truncated: nextStartLine !== null, nextStartLine };
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
          throw new Error(`Artifact line ${currentLine} exceeds the ${MAX_READ_BYTES}-byte read limit; use a tool that supports oversized lines`);
        }
        if (fragment.includes(0)) throw new Error('Binary artifacts require a different tool');
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

/** Package-local CLI entry logic; the public tool always invokes this in a child process. */
export async function readerRequest(input: unknown): Promise<Record<string, unknown>> {
  const request = objectArguments(input, ['operation', 'root', 'directory', 'args']);
  if (typeof request.root !== 'string' || typeof request.directory !== 'boolean' || !['read', 'list'].includes(request.operation as string)) throw new Error('Invalid reader request');
  const operation = request.operation as 'read' | 'list';
  const args = objectArguments(request.args, operation === 'read' ? ['path', 'startLine', 'lineCount'] : ['path', 'offset', 'limit']);
  const path = internalPath(args.path);
  if (operation === 'read') {
    if (request.directory && !path) throw new Error('Reading a directory artifact requires an internal file path');
    if (!request.directory && Object.hasOwn(args, 'path')) throw new Error('A file artifact read does not accept path');
    const startLine = integer(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER, 'startLine');
    const lineCount = integer(args.lineCount, 80, 1, 500, 'lineCount');
    const candidate = await scopedTarget(request.root, request.directory, path);
    const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Reading requires a regular file; list the directory first');
      return { path, ...await readLines(file, info.size, startLine, lineCount) };
    } finally { await file.close(); }
  }
  if (!request.directory) throw new Error('Listing requires a directory artifact');
  const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = integer(args.limit, 200, 1, 200, 'limit');
  const candidate = await scopedTarget(request.root, true, path);
  const all = await readdir(candidate, { withFileTypes: true });
  all.sort((a, b) => a.name.localeCompare(b.name));
  const entries = all.slice(offset, offset + limit).map(entry => ({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name,
    kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' }));
  return { path, entries, totalEntries: all.length, nextOffset: offset + entries.length < all.length ? offset + entries.length : null };
}
