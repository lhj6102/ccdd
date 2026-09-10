import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkspaceConfig } from '../src/broker/config.js';
import { createReviewTools } from '../src/tools/runner.js';
import { matchesToolManifest } from '../src/tools/manifest.js';
import { checkEnvironmentRequirements } from '../src/tools/environment.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';

test('historical locale-ordered manifests reconnect only with their original module bytes and configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-manifest-compatibility-')), root = join(dir, 'input');
  await mkdir(root); t.after(() => removeOwnedWorkspaceTree(dir));
  await writeFile(join(root, '\u00e4.ts'), 'export const value = 1;');
  await writeFile(join(root, 'z.ts'), 'export const value = 2;');
  await writeFile(join(root, 'ready.mjs'), 'console.log("Ready");');
  await writeFile(join(root, 'text.txt'), 'input');
  await writeFile(join(root, 'ccdd.config.ts'), `import './\u00e4.ts'; import './z.ts';
    export default { artifacts: { text: { type: 'text', path: 'text.txt' } },
      artifactTypes: { text: { humanTools: { view: {
        metadata: { description: 'Inspect text', inputSchema: { type: 'object' }, resultKinds: ['text'], observation: 'none' },
        execute() { return { content: [{ type: 'text', text: 'Actual matching implementation' }] }; }
      } } } },
      envRequirements: { ready: { description: 'Ready', script: 'ready.mjs' } },
      critics: [{ id: 'human', title: 'Human', target: 'text', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Inspect text.' } }]
    };`);
  const config = (await readWorkspaceConfig(root)).config;
  const saved = structuredClone(config.configManifest!);
  saved.modules.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  assert.notDeepEqual(saved.modules, config.configManifest!.modules);
  // Reproduce the former writer's v1 hash recipe, independently of the new matcher.
  saved.configHash = createHash('sha256').update(JSON.stringify({
    values: { artifacts: config.artifacts, critics: config.critics }, types: saved.types, modules: saved.modules,
    envRequirements: saved.envRequirements, environmentInputs: saved.environmentInputs,
  })).digest('hex');
  assert.equal(matchesToolManifest(config, saved), true);
  const registry = await createReviewTools({ worktreePath: root, artifacts: [{ id: 'text', type: 'text', path: 'text.txt' }], artifactTypes: config.artifactTypes, configManifest: saved, audience: 'human', criticId: 'human', runDir: join(dir, 'output') });
  try { assert.equal((await registry.call('view_text')).content[0].text, 'Actual matching implementation'); }
  finally { await registry.close(); }
  assert.equal((await checkEnvironmentRequirements({ workspacePath: root, configManifest: saved, outputDir: join(dir, 'checks') })).ok, true);
  const altered = structuredClone(saved); altered.modules[0].hash = '0'.repeat(64);
  assert.equal(matchesToolManifest(config, altered), false);
  const changedConfig = structuredClone(config); changedConfig.critics[0].payload.instruction = 'Different instruction';
  assert.equal(matchesToolManifest(changedConfig, saved), false);
  const wrongHash = structuredClone(saved); wrongHash.configHash = '0'.repeat(64);
  assert.equal(matchesToolManifest(config, wrongHash), false);
  await writeFile(join(root, 'z.ts'), 'export const value = 3;');
  const changedModule = (await readWorkspaceConfig(root)).config;
  assert.equal(matchesToolManifest(changedModule, saved), false);
  assert.equal(await readFile(join(root, 'text.txt'), 'utf8'), 'input');
});
