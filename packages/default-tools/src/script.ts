#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { resolveScopePath } from '@ccdd/core';
import type { JsonValue, ScriptToolRequest, ToolResult } from '@ccdd/core';
import { readerRequest, scopedTarget, objectArguments, internalPath } from './reader.js';
import { imageRequest } from './image.js';
import { imageContent } from './image-result.js';
import { human } from './index.js';

/** Standard language-neutral tool entry point. Fixed argv selects the operation. */
export async function scriptRequest(operation: string, input: ScriptToolRequest, options: Record<string, unknown> = {}): Promise<ToolResult> {
  if (input.version !== 1 || !input.context || !input.args || Array.isArray(input.args)) throw new Error('Expected a version 1 CCDD script request.');
  const { context, args } = input;
  if (!Object.hasOwn(context.scope, context.artifactId) || context.scope[context.artifactId].path !== context.artifactPath) throw new Error('Invalid Artifact scope.');
  const logical = internalPath(args.path), resolved = resolveScopePath(context.scope, context.artifactId, logical);
  const root = context.scope[resolved.artifactId].path;
  const target = await scopedTarget(root, true, resolved.path);
  if (operation === 'read') {
    objectArguments(args, ['path', 'startLine', 'lineCount']);
    if (!logical) throw new Error('read requires a file path inside the Artifact.');
    const data = await readerRequest({ operation: 'read', root: target, directory: false, args: { ...(args.startLine === undefined ? {} : { startLine: args.startLine }), ...(args.lineCount === undefined ? {} : { lineCount: args.lineCount }) } });
    return { content: [{ type: 'json', data: { ...data, artifactId: context.artifactId, resolvedArtifactId: resolved.artifactId, path: logical } as JsonValue }],
      ...(typeof data.lineCount === 'number' && data.lineCount > 0 ? { observation: { kind: 'content' } } : data.totalLines === 0 ? { observation: { kind: 'empty' } } : {}) };
  }
  if (operation === 'list') {
    objectArguments(args, ['path', 'offset', 'limit']);
    const offset = args.offset ?? 0, limit = args.limit ?? 200;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('Invalid listing pagination.');
    const entries = (await readdir(target, { withFileTypes: true })).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' }));
    if (!resolved.path) for (const name of Object.keys(context.scope[resolved.artifactId].mounts)) entries.push({ name, kind: 'mount' });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const selected = entries.slice(Number(offset), Number(offset) + Number(limit)).map(entry => ({ ...entry, path: logical ? `${logical}/${entry.name}` : entry.name }));
    return { content: [{ type: 'json', data: { artifactId: context.artifactId, path: logical, entries: selected, totalEntries: entries.length, nextOffset: Number(offset) + selected.length < entries.length ? Number(offset) + selected.length : null } }] };
  }
  if (operation === 'image') {
    objectArguments(args, ['path']);
    if (!logical) throw new Error('image requires a file path inside the Artifact.');
    return { content: [imageContent(await imageRequest({ operation: 'view_image', root: target, directory: false, args: {} }))], observation: { kind: 'content' } };
  }
  if (operation === 'open') {
    objectArguments(args, ['path']);
    const tool = human.desktop.open(options);
    return tool.execute({ ...context, signal: new AbortController().signal, artifactDirectory: true,
      resolvePath: async (name = '') => { const entry = resolveScopePath(context.scope, context.artifactId, name); return scopedTarget(context.scope[entry.artifactId].path, true, entry.path); } }, args);
  }
  throw new Error('Select read, list, image or open.');
}

try {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Script request exceeds 8 MiB.'); }
  const result = await scriptRequest(process.argv[2], JSON.parse(text), process.argv[3] ? JSON.parse(process.argv[3]) : {});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Artifact tool failed.'}\n`);
  process.exitCode = 1;
}
