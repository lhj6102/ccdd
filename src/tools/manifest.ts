import { isDeepStrictEqual } from 'node:util';
import type { RepoConfig } from '../contracts.js';
import type { ConfigManifest } from './contracts.js';
export function matchesToolManifest(config: RepoConfig, recorded: ConfigManifest): boolean {
  return recorded?.version === 2 && isDeepStrictEqual(config.configManifest, recorded);
}
