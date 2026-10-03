import type { RepoConfig } from '../contracts.js';
import type { ProjectSelection } from './types.js';
import { includedCritics } from './query.js';
import { identifier } from '../broker/config.js';

/** A declared name or an explicit per-Critic selection; no source file is rewritten. */
export type ProfileSelection = string | Record<string, string>;
export function selectProfiles(config: RepoConfig, profile: ProfileSelection | undefined, selection: ProjectSelection = { kind: 'all' }, recursive = false): RepoConfig {
  if (profile === undefined) return config;
  const ids = new Set(includedCritics({ config } as import('./types.js').ProjectSnapshot, selection, recursive));
  const mapping = typeof profile === 'string' ? Object.fromEntries([...ids].map(id => [id, profile])) : profile;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('A profile selection must name declared variants.');
  const critics = new Map(config.critics.map(critic => [critic.id, critic]));
  for (const [id, name] of Object.entries(mapping)) {
    if (!ids.has(id)) throw new Error(`Profile selection is outside the submitted Critic scope: ${id}`);
    if (typeof name !== 'string' || !identifier.test(name) || !Object.hasOwn(critics.get(id)!.profileVariants ?? {}, name)) throw new Error(`Unknown profile variant for ${id}: ${String(name)}`);
  }
  return { ...config, critics: config.critics.map(critic => Object.hasOwn(mapping, critic.id)
    ? { ...critic, profile: structuredClone(critic.profileVariants![mapping[critic.id]]) } : critic) };
}
