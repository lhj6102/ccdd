import type { ArtifactScope } from './definitions.js';

/** Resolve logical paths without a filesystem. Every hop consumes path components. */
export function resolveScopePath(scope: ArtifactScope, artifactId: string, path = ''): { artifactId: string; path: string } {
  if (typeof path !== 'string' || path.length > 4096 || /[\\\x00-\x1f\x7f:]/.test(path) || path.startsWith('/') || path.split('/').some(part => part === '.' || part === '..' || !part && path !== '')) throw new Error('Artifact path must be a safe relative logical path.');
  let current = artifactId, remaining = path;
  for (;;) {
    if (!Object.hasOwn(scope, current)) throw new Error(`Artifact is outside this review: ${current}`);
    const entry = scope[current];
    if (!remaining) return { artifactId: current, path: '' };
    const first = remaining.split('/')[0];
    if (Object.hasOwn(entry.mounts, first)) {
      current = entry.mounts[first]; remaining = remaining.slice(first.length).replace(/^\//, ''); continue;
    }
    const child = Object.keys(entry.children).find(name => remaining === name || remaining.startsWith(`${name}/`));
    if (child !== undefined) { current = entry.children[child]; remaining = remaining.slice(child.length).replace(/^\//, ''); continue; }
    // A family folder belongs to its instances, not to the parent: address it as <folder>/<instance>/<path>.
    for (const [name, id] of Object.entries(entry.children)) {
      const folder = name.slice(0, -id.length - 1);
      if (scope[id]?.family && name.endsWith(`/${id}`) && (remaining === folder || remaining.startsWith(`${folder}/`))) throw new Error(`Artifact path is inside the folder of Artifact family ${scope[id].family!.name}; address one of its instances as ${folder}/<instance>/<path>.`);
    }
    return { artifactId: current, path: remaining };
  }
}
