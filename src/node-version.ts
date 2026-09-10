// Release scripts use this source through native TypeScript loading; packaged
// executors use the compiled module so both apply the same runtime requirement.
export const supportedNodeRange = '^22.19.0';
export const nodeRequirement = 'Node.js 22 LTS (>=22.19.0)';

export function supportsNodeVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major === 22 && minor >= 19;
}
