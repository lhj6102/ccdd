import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export function within(root: string, target: string): boolean { const sub=relative(root,target); return !isAbsolute(sub)&&sub!=='..'&&!sub.startsWith(`..${sep}`); }
export async function scopedPath(root: string, path = ''): Promise<string> {
  if (typeof path!=='string'||path.includes('\0')||path.includes('\\')||isAbsolute(path)||path.split('/').some(part=>part==='..'||part==='.')) throw new Error('Artifact path must be relative to its declared root.');
  let target=root;
  for (const component of path.split('/').filter(Boolean)) { target=resolve(target,component); if ((await lstat(target)).isSymbolicLink()) throw new Error('Artifact symlinks are not supported.'); }
  const actual=await realpath(target);
  if (!within(root,actual)) throw new Error('Artifact path escapes its declared root.');
  return actual;
}
