import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { scopedPath, within } from './paths.js';
import { projectInputPath } from './schema.js';

async function internalLink(root: string, target: string): Promise<string> {
  const link = await readlink(target);
  if (posix.isAbsolute(link) || win32.isAbsolute(link) || /[\\\x00-\x1f\x7f]/.test(link) || !within(root, resolve(dirname(target), link)) || !within(root, await realpath(target))) throw new Error('Runtime symlinks must stay inside their declared execution input.');
  return link;
}

/** A bundled runtime may use relative internal links, but may not select undeclared host files. */
export async function resolveExecutionInput(root: string, declarations: readonly string[], requested: string): Promise<string> {
  projectInputPath(requested);
  const declaration = declarations.find(input => requested === input || requested.startsWith(`${input}/`));
  if (declaration === undefined) throw new Error('Execution path is not declared by this tool.');
  const base = await scopedPath(root, declaration);
  if (requested === declaration) return base;
  let candidate = base;
  for (const component of requested.slice(declaration.length + 1).split('/')) {
    candidate = join(candidate, component);
    if ((await lstat(candidate)).isSymbolicLink()) await internalLink(base, candidate);
  }
  const actual = await realpath(candidate);
  if (!within(base, actual)) throw new Error('Execution path escapes its declared runtime.');
  return actual;
}

/** Runtime content participates independently of the whole-workspace snapshot hash. */
export async function hashExecutionInputs(root: string, paths: readonly string[], signal?: AbortSignal): Promise<{ path: string; hash: string }[]> {
  const result: { path: string; hash: string }[] = [];
  for (const input of [...new Set(paths)].sort()) {
    projectInputPath(input);
    const absolute = await scopedPath(root, input), hash = createHash('sha256');
    const walk = async (target: string, name: string): Promise<void> => {
      signal?.throwIfAborted();
      const info = await lstat(target);
      if (info.isDirectory()) {
        hash.update(JSON.stringify([name, 'directory']));
        for (const child of (await readdir(target)).sort()) await walk(join(target, child), `${name}/${child}`);
      } else if (info.isFile()) {
        const content = createHash('sha256');
        for await (const bytes of createReadStream(target, { signal })) content.update(bytes);
        hash.update(JSON.stringify([name, 'file', info.mode & 0o111, content.digest('hex')]));
      } else if (info.isSymbolicLink()) {
        hash.update(JSON.stringify([name, 'symlink', await internalLink(absolute, target)]));
      } else throw new Error(`Execution inputs must contain regular files, directories or internal runtime symlinks: ${name}`);
    };
    await walk(absolute, input);
    result.push({ path: input, hash: hash.digest('hex') });
  }
  return result;
}
