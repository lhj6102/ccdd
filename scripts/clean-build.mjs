import { lstat, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const target = join(root, 'dist');
const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (info) {
  const resolved = await realpath(target), scope = relative(root, resolved);
  if (info.isSymbolicLink() || scope !== 'dist' || isAbsolute(scope)) throw new Error('Build cleanup must stay inside the workspace dist directory.');
  await rm(resolved, { recursive: true, force: true });
}
