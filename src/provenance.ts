import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { hashExecutionInputs } from './tools/inputs.js';
import { scopedPath } from './tools/paths.js';
import type { ReviewRequest } from './contracts.js';
import { resourcePaths } from './resources.js';

export interface ExecutionProvenance {
  attemptId: string;
  capturedAt: string;
  binding: 'declared-runtime-pin';
  inputs: { path: string; structuralSha256: string }[];
  files: { path: string; rawContentSha256: string; executable: number }[];
}
async function files(root: string, paths: string[], signal?: AbortSignal): Promise<ExecutionProvenance['files']> {
  const output = new Map<string, ExecutionProvenance['files'][number]>();
  const walk = async (name: string) => {
    signal?.throwIfAborted();
    const target = join(root, name), stat = await lstat(target);
    if (stat.isDirectory()) { for (const child of (await readdir(target)).sort()) await walk(`${name}/${child}`); }
    else if (stat.isFile()) {
      const digest = createHash('sha256');
      for await (const data of createReadStream(target, { signal })) digest.update(data);
      output.set(name, { path: name, rawContentSha256: digest.digest('hex'), executable: stat.mode & 0o111 });
    }
    // Internal symlinks are represented by the structural digest, not mislabeled as files.
  };
  for (const name of paths) await walk(name);
  return [...output.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
const changed = () => Object.assign(new Error('Declared runtime changed while capturing or executing pinned bytes.'), { code: 'WORKSPACE_RUNTIME_CHANGED' });
/** Pin only declared runtime material, never the reviewed workspace. Equal captures share immutable content-addressed storage. */
export async function captureExecution(request: ReviewRequest, attemptId: string, signal?: AbortSignal) {
  const declared = request.configManifest.executionInputs ?? [];
  const paths = declared.map(input => input.path).sort();
  if (!paths.length) return null;
  const source = await realpath(request.worktreePath);
  const expected = await hashExecutionInputs(source, paths, signal);
  if (JSON.stringify(expected) !== JSON.stringify([...declared].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(input => ({ path: input.path, hash: input.hash })))) throw changed();
  const key = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  const directory = join(dirname(resourcePaths().database), 'runtime-content');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = join(directory, key), temporary = join(directory, `capture-${randomUUID()}`);
  if (!(await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) {
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (const name of paths.filter(name => !paths.some(parent => parent !== name && name.startsWith(`${parent}/`)))) {
        const target = join(temporary, name); await mkdir(dirname(target), { recursive: true });
        await cp(await scopedPath(source, name), target, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
      }
      if (JSON.stringify(await hashExecutionInputs(temporary, paths, signal)) !== JSON.stringify(expected)) throw changed();
      try { await rename(temporary, root); } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const verify = async () => { if (JSON.stringify(await hashExecutionInputs(root, paths, signal)) !== JSON.stringify(expected)) throw changed(); };
  await verify();
  const rawFiles = await files(root, paths, signal);
  await verify();
  const provenance: ExecutionProvenance = { attemptId, capturedAt: new Date().toISOString(), binding: 'declared-runtime-pin', inputs: expected.map(input => ({ path: input.path, structuralSha256: input.hash })), files: rawFiles };
  return { root, paths, provenance, verify };
}
/** Fixed command/argv paths inside a declaration bind to its captured runtime tree. */
export function pinnedArgument(argument: string, cwd: string, workspace: string, root: string, declarations: readonly string[]): string {
  if (!argument || argument.startsWith('-')) return argument;
  const name = relative(workspace, resolve(cwd, argument)).split(sep).join('/');
  return declarations.some(input => name === input || name.startsWith(`${input}/`)) ? join(root, name) : argument;
}
