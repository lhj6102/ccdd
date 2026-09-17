import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceConfig } from '../src/broker/config.js';
import { prepareHumanReview, type HumanPreparationProgress } from '../src/executors/human-preparation.js';
import { prepareWorkspace, removeOwnedWorkspaceTree, type WorkspaceMode } from '../src/workspaces/index.js';
import type { ReviewEnvelope } from '../src/contracts.js';

async function fixture(t: TestContext, mode: WorkspaceMode, mutateDuringPreflight = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-human-boundary-')));
  const repoPath = join(directory, 'project'), marker = join(directory, 'config-imports');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'asset.txt'), 'fixed review input');
  await writeFile(join(repoPath, 'ccdd.config.ts'), `
    import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
    export default {
      artifacts: { asset: { type: 'text', path: 'asset.txt' } },
      artifactTypes: { text: { humanTools: { inspect: {
        metadata: { description: 'Inspect {artifactName}.', inputSchema: { type: 'object' }, resultKinds: ['text'], observation: 'none' },
        preflight(context) {
          ${mutateDuringPreflight ? "chmodSync(context.artifactPath, 0o600); writeFileSync(context.artifactPath, 'mutated during readiness');" : ''}
          return { ok: true, message: 'Synthetic readiness check.' };
        },
        execute() { throw new Error('Artifact execution is outside preparation.'); }
      } } } },
      critics: [{ id: 'human', title: 'Inspect asset', target: 'asset', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Inspect {asset}.' } }]
    };`);
  const workspace = await prepareWorkspace({ repoPath, stateDir: join(directory, 'state'), mode });
  const { config } = await readWorkspaceConfig(workspace.descriptor.path);
  const request: ReviewEnvelope = {
    repoId: 'fixture', snapshotHash: workspace.descriptor.hash, ...config.critics[0], criticId: config.critics[0].id,
    artifacts: [{ id: 'asset', type: 'text', path: 'asset.txt' }], artifactTypes: config.artifactTypes,
    configManifest: config.configManifest,
  };
  await workspace.close();
  t.after(() => removeOwnedWorkspaceTree(directory));
  const prepare = (signal?: AbortSignal, onProgress?: (progress: HumanPreparationProgress) => void) =>
    prepareHumanReview(request, workspace.descriptor, join(directory, 'preparation'), signal, onProgress);
  return { directory, marker, workspace: workspace.descriptor, request, prepare };
}

for (const mode of ['lock', 'copy'] as const) {
  test(`${mode} Human preparation validates acquisition and completion without an intervening duplicate scan`, async t => {
    const data = await fixture(t, mode), completed: string[] = [];
    const preparation = await data.prepare(undefined, event => {
      if (event.progress?.kind === 'content' && event.progress.completed) completed.push(event.phase);
    });
    assert.deepEqual(completed, ['validating-input', 'final-validation']);
    assert.equal(preparation.snapshotHash, data.workspace.hash);
    assert.equal(preparation.tools.length, 1);
    assert.equal(preparation.tools[0].ok, true);
    assert.equal(Object.hasOwn(preparation, 'verdict'), false);
  });

  test(`${mode} Human preparation rejects changed input before configuration can execute`, async t => {
    const data = await fixture(t, mode), imports = await readFile(data.marker, 'utf8');
    await chmod(join(data.workspace.path, 'asset.txt'), 0o600);
    await writeFile(join(data.workspace.path, 'asset.txt'), 'changed before Claim');
    await assert.rejects(data.prepare(), /workspace changed|readonly|read.only/i);
    assert.equal(await readFile(data.marker, 'utf8'), imports);
  });

  test(`${mode} Human preparation rejects a readiness check that mutates reviewed input`, async t => {
    const data = await fixture(t, mode, true);
    await assert.rejects(data.prepare(), /workspace changed|readonly|read.only/i);
    assert.equal(await readFile(join(data.workspace.path, 'asset.txt'), 'utf8'), 'mutated during readiness');
  });
}

test('cancellation after validated acquisition prevents configuration and readiness work', async t => {
  const data = await fixture(t, 'lock'), imports = await readFile(data.marker, 'utf8');
  const controller = new AbortController();
  await assert.rejects(data.prepare(controller.signal, progress => {
    if (progress.phase === 'checking-manifest') controller.abort(new Error('Fixture Claim cancelled.'));
  }), /Fixture Claim cancelled/);
  assert.equal(await readFile(data.marker, 'utf8'), imports);
});
