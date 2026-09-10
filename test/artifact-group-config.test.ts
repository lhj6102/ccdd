import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readWorkspaceConfig } from '../src/broker/config.js';
import type { ArtifactEntryDefinition, RepoConfig } from '../src/contracts.js';
import type { ArtifactDefinition, ArtifactGroupDefinition } from '../src/sdk.js';

const leaf: ArtifactDefinition = { type: 'text', path: 'effect.txt' };
const group: ArtifactGroupDefinition = { kind: 'group', members: ['effect', 'preview'] };
const definitions: Record<string, ArtifactEntryDefinition> = {
  effect: leaf,
  preview: { type: 'text', path: 'preview.txt' },
  explosion: group,
  additional: { type: 'text', path: 'additional.txt' },
  bundle: { kind: 'group', members: ['explosion', 'preview', 'additional'] },
  outside: { type: 'text', path: 'outside.txt' },
};
const profile = { kind: 'human' } as const;
const critic = (id: string, target: string, deps: string[] = []) => ({ id, title: id, target, deps, profile, payload: { instruction: 'Review the target.' } });
function config(): RepoConfig {
  return {
    artifacts: structuredClone(definitions),
    artifactTypes: { text: { viewer: 'text', humanTools: { read: {} } } },
    critics: [critic('group-review', 'explosion'), critic('effect-review', 'effect'), critic('preview-review', 'preview'), critic('publish', 'outside', ['explosion'])],
  };
}
const tree = Object.values(definitions).flatMap(artifact => 'path' in artifact ? [{ path: artifact.path, type: 'blob', mode: '100644' }] : []);

test('workspace config validates leaf files and preserves pathless group definitions', async () => {
  const c = config();
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ccdd-group-config-'));
  try {
    await Promise.all(tree.map(entry => writeFile(path.join(folder, entry.path), entry.path)));
    await writeFile(path.join(folder, 'ccdd.config.json'), JSON.stringify(c));
    const loaded = await readWorkspaceConfig(folder);
    assert.deepEqual(loaded.config.artifacts.explosion, group);
    assert.deepEqual(loaded.config.artifacts.bundle, definitions.bundle);
    await rm(path.join(folder, 'effect.txt'));
    await assert.rejects(readWorkspaceConfig(folder), /without symlinks: effect/);
    await writeFile(path.join(folder, 'effect.txt'), 'restored');
    for (const members of [[], ['missing'], ['effect', 'effect'], ['bundle']]) {
      await writeFile(path.join(folder, 'ccdd.config.json'), JSON.stringify({ ...c,
        artifacts: { ...c.artifacts, explosion: { kind: 'group', members } } }));
      await assert.rejects(readWorkspaceConfig(folder));
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
