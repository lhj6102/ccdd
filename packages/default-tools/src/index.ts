import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonSchema, JsonValue, ToolContext, ToolDefinition, ToolResult } from '@lhj6102/ccdd';
import { internalPath, objectArguments } from './reader.js';
import { runToolProcess, toolEnvironment } from './process.js';
import { imageContent, MAX_IMAGE_OUTPUT_BYTES } from './image-result.js';

export interface ReaderOptions { description?: string; timeoutMs?: number }
export interface ReadArguments { startLine?: number; lineCount?: number }
export interface FileReadArguments extends ReadArguments { path: string }
export interface ListArguments { path?: string; offset?: number; limit?: number }
export interface ImageViewArguments { path?: string }
export interface DesktopOpenArguments { path?: string }
export interface DesktopOpenOptions {
  /** Registered executable, never supplied by a reviewer. Defaults to macOS /usr/bin/open. */
  command?: string;
  /** Fixed argv containing a standalone {artifactPath}. Omit to append the Artifact path. */
  args?: string[];
  /** macOS application name or bundle path, passed to /usr/bin/open -a. */
  app?: string;
  description?: string;
  timeoutMs?: number;
}
export interface DefaultToolDefinition<Args> extends ToolDefinition<Args> {
  execute(context: ToolContext, args: Args): Promise<ToolResult>;
  preflight(context: ToolContext): Promise<{ ok: boolean; message: string }>;
}

function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw new Error('timeoutMs must be an integer from 1 to 120000');
  return value;
}

async function availableExecutable(command: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!command || command.includes('\0') || (!isAbsolute(command) && /[/\\]/.test(command))) throw new Error('Tool executable must be an absolute path or a PATH command name');
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, command));
  for (const candidate of candidates) {
    signal.throwIfAborted();
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      signal.throwIfAborted();
      return candidate;
    } catch { signal.throwIfAborted(); }
  }
  throw new Error('The registered tool executable is unavailable');
}

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

async function prepareReader(context: ToolContext, directory: boolean): Promise<string> {
  context.signal.throwIfAborted();
  if (context.artifactDirectory !== directory) throw new Error(directory ? 'This tool requires a directory Artifact' : 'This tool requires a file Artifact');
  const root = await context.resolvePath();
  const info = await stat(root);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('Artifact shape changed');
  await access(cliPath, constants.R_OK);
  await access(process.execPath, constants.X_OK);
  context.signal.throwIfAborted();
  return root;
}

function readSchema(directory: boolean): JsonSchema {
  return {
    type: 'object',
    properties: {
      ...(directory ? { path: { type: 'string', minLength: 1, description: 'A file path relative to this Artifact directory.' } } : {}),
      startLine: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1, description: 'First line to read, starting at 1.' },
      lineCount: { type: 'integer', minimum: 1, maximum: 500, default: 80, description: 'Maximum number of complete lines to return.' },
    },
    ...(directory ? { required: ['path'] } : {}), additionalProperties: false,
  };
}

function readerTool<Args>(operation: 'read' | 'list', directory: boolean, options: ReaderOptions): DefaultToolDefinition<Args> {
  const timeoutMs = timeout(options.timeoutMs, 30_000);
  return {
    metadata: {
      description: options.description ?? (operation === 'list' ? 'List files and directories inside {artifactName}.' : 'Read complete UTF-8 text lines from {artifactName}.'),
      inputSchema: operation === 'read' ? readSchema(directory) : {
        type: 'object', properties: {
          path: { type: 'string', description: 'Optional directory path relative to this Artifact.' },
          offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 200 },
        }, additionalProperties: false,
      },
      resultKinds: ['json'], observation: operation === 'read' ? 'content' : 'none', artifactKind: directory ? 'directory' : 'file', timeoutMs,
    },
    async execute(context, args): Promise<ToolResult> {
      const root = await prepareReader(context, directory);
      const actualArgs = objectArguments(args, operation === 'read' ? (directory ? ['path', 'startLine', 'lineCount'] : ['startLine', 'lineCount']) : ['path', 'offset', 'limit']);
      const path = internalPath(actualArgs.path);
      if (operation === 'read' && directory && !path) throw new Error('Reading a directory artifact requires an internal file path');
      // Resolve with the Runner before sending data to the independent CLI path checks.
      await context.resolvePath(path || undefined);
      const raw = await runToolProcess(process.execPath, [cliPath], {
        cwd: context.outputDir, env: toolEnvironment(context.tmpDir), signal: context.signal, timeoutMs,
        input: JSON.stringify({ operation, root, directory, args: actualArgs }),
      });
      context.signal.throwIfAborted();
      const response = JSON.parse(raw) as { ok: boolean; data?: Record<string, JsonValue>; message?: string };
      if (!response.ok || !response.data) throw new Error(response.message ?? 'Invalid reader CLI response');
      const data: Record<string, JsonValue> = { artifactId: context.artifactId, ...response.data };
      const observed = operation === 'read' && typeof data.lineCount === 'number' && data.lineCount > 0;
      const empty = operation === 'read' && data.lineCount === 0 && data.totalLines === 0;
      return {
        content: [{ type: 'json', data }],
        ...(observed ? { observation: { kind: 'content' as const } } : empty ? { observation: { kind: 'empty' as const } } : {}),
      };
    },
    async preflight(context) {
      try {
        await prepareReader(context, directory);
        return { ok: true, message: 'Artifact and package-local Node CLI are available. No content was read.' };
      } catch (error) {
        context.signal.throwIfAborted();
        return { ok: false, message: error instanceof Error ? error.message : 'Reader preparation failed' };
      }
    },
  };
}

function desktopOpen(options: DesktopOpenOptions = {}): DefaultToolDefinition<DesktopOpenArguments> {
  if (options.app !== undefined && (typeof options.app !== 'string' || !options.app || options.app.includes('\0'))) throw new Error('app must be a nonempty application name or path');
  if (options.app !== undefined && (options.command !== undefined || options.args !== undefined)) throw new Error('app cannot be combined with command or args');
  if (options.command !== undefined && (typeof options.command !== 'string' || !options.command || options.command.includes('\0'))) throw new Error('command must be a nonempty executable name or path');
  if (options.args !== undefined && (!Array.isArray(options.args) || !options.args.includes('{artifactPath}') || options.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || (arg.includes('{artifactPath}') && arg !== '{artifactPath}')))) throw new Error('args must include a standalone {artifactPath} token');
  if (options.args !== undefined && options.command === undefined) throw new Error('args requires an explicit command');
  const configured = { ...options, ...(options.args ? { args: [...options.args] } : {}) };
  const timeoutMs = timeout(options.timeoutMs, 10_000);
  const command = (): string => {
    if (configured.command) return configured.command;
    if (process.platform !== 'darwin') throw new Error('The default desktop opener is supported on macOS. Register an explicit command on this platform.');
    return '/usr/bin/open';
  };
  return {
    metadata: {
      description: options.description ?? 'Open {artifactName} in a desktop application. Opening does not submit a verdict.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Optional internal path for a directory Artifact. Omit for the Artifact itself.' } }, additionalProperties: false },
      resultKinds: ['launch'], observation: 'none', artifactKind: 'any', timeoutMs,
    },
    async execute(context, args) {
      const actualArgs = objectArguments(args, ['path']);
      if (!context.artifactDirectory && Object.hasOwn(actualArgs, 'path')) throw new Error('A file Artifact open does not accept path');
      const target = await context.resolvePath(internalPath(actualArgs.path) || undefined);
      const executable = await availableExecutable(command(), context.signal);
      const argv = configured.args ? configured.args.map(arg => arg === '{artifactPath}' ? target : arg)
        : configured.command ? [target] : [...(configured.app ? ['-a', configured.app] : []), '--', target];
      await runToolProcess(executable, argv, { cwd: context.outputDir, env: toolEnvironment(context.tmpDir, true), signal: context.signal, timeoutMs, capture: false });
      context.signal.throwIfAborted();
      return { content: [{ type: 'launch', launched: true }] };
    },
    async preflight(context) {
      try {
        await context.resolvePath();
        await availableExecutable(command(), context.signal);
        return { ok: true, message: 'Artifact and registered desktop opener are available. No application was launched.' };
      } catch (error) {
        context.signal.throwIfAborted();
        return { ok: false, message: error instanceof Error ? error.message : 'Desktop opener preparation failed' };
      }
    },
  };
}

function imageView(options: ReaderOptions = {}): DefaultToolDefinition<ImageViewArguments> {
  const timeoutMs = timeout(options.timeoutMs, 30_000);
  return {
    metadata: {
      description: options.description ?? 'View a PNG, JPEG or WebP image from {artifactName}. Omit path for a file Artifact; a directory Artifact requires an internal file path. Images must be at most 4 MiB.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, description: 'Required internal image path for a directory Artifact. Omit for a file Artifact.' } }, additionalProperties: false },
      resultKinds: ['image'], observation: 'content', artifactKind: 'any', timeoutMs,
    },
    async execute(context, args) {
      const root = await prepareReader(context, context.artifactDirectory);
      const actualArgs = objectArguments(args, ['path']);
      const path = internalPath(actualArgs.path);
      if (context.artifactDirectory && !path) throw new Error('Viewing an image in a directory Artifact requires an internal file path');
      if (!context.artifactDirectory && Object.hasOwn(actualArgs, 'path')) throw new Error('A file Artifact image view does not accept path');
      await context.resolvePath(path || undefined);
      const raw = await runToolProcess(process.execPath, [cliPath], {
        cwd: context.outputDir, env: toolEnvironment(context.tmpDir), signal: context.signal, timeoutMs,
        input: JSON.stringify({ operation: 'view_image', root, directory: context.artifactDirectory, args: actualArgs }),
        maxOutputBytes: MAX_IMAGE_OUTPUT_BYTES,
      });
      context.signal.throwIfAborted();
      const response = JSON.parse(raw) as { ok: boolean; data?: unknown; message?: string };
      if (!response.ok) throw new Error(response.message ?? 'Invalid image CLI response');
      const content = imageContent(response.data);
      return { content: [content], observation: { kind: 'content' } };
    },
    async preflight(context) {
      try {
        await prepareReader(context, context.artifactDirectory);
        await access(fileURLToPath(import.meta.resolve('@earendil-works/pi-agent-core')), constants.R_OK);
        context.signal.throwIfAborted();
        return { ok: true, message: 'Artifact and package-local image CLI are available. No image was read.' };
      } catch (error) {
        context.signal.throwIfAborted();
        return { ok: false, message: error instanceof Error ? error.message : 'Image preparation failed' };
      }
    },
  };
}

/** Pure factories: importing this library or constructing tools performs no registration, I/O or process execution. */
export const agent = {
  text: { read: (options: ReaderOptions = {}): DefaultToolDefinition<ReadArguments> => readerTool('read', false, options) },
  files: {
    read: (options: ReaderOptions = {}): DefaultToolDefinition<FileReadArguments> => readerTool('read', true, options),
    list: (options: ReaderOptions = {}): DefaultToolDefinition<ListArguments> => readerTool('list', true, options),
  },
  image: { view: imageView },
};
export const human = { desktop: { open: desktopOpen } };
