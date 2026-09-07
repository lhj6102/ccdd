import { cp, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const packageRoot = await realpath(join(root, 'packages/project'));
const output = join(packageRoot, 'dist');
const info = await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (info) {
  const resolved = await realpath(output), scope = relative(packageRoot, resolved);
  if (info.isSymbolicLink() || scope !== 'dist' || isAbsolute(scope)) throw new Error('Project package cleanup must stay inside its dist directory.');
  await rm(resolved, { recursive: true, force: true });
}
await mkdir(output, { recursive: true });
for (const directory of ['src', 'scripts', 'monitor-ui']) await cp(join(root, 'dist', directory), join(output, directory), { recursive: true });
