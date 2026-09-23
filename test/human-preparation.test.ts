import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews } from './helpers/artifacts.js';
import { prepareHumanReview, type HumanPreparationProgress } from '../src/executors/human-preparation.js';
import { prepareWorkspace } from '../src/workspaces/index.js';

async function fixture(t: Parameters<typeof artifactFixture>[0], mutate = false) {
  const data = await artifactFixture(t), marker = join(data.root, 'executed');
  await data.write('', { name: 'asset', views: fixtureViews(), envRequirements: { check: { description: 'Check environment', script: 'check.mjs' } }, critics: [{ id: 'human', title: 'Inspect', profile: { kind: 'human' }, payload: { instruction: 'Read {asset}.' } }] }, {
    'check.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'checked');${mutate ? "writeFileSync('content.txt','mutated during readiness');" : ''}`,
  });
  const handle = await prepareWorkspace(data), [original] = await data.requests(), request = { ...original, snapshotHash: handle.descriptor.hash }; await handle.close();
  return { ...data, marker, workspace: handle.descriptor, prepare: (signal?: AbortSignal, progress?: (value: HumanPreparationProgress) => void) => prepareHumanReview(request, handle.descriptor, join(data.root, 'preparation'), signal, progress) };
}

test('Human preparation checks acquisition and completion without an intervening duplicate content scan', async t => {
  const data = await fixture(t), phases: string[] = [];
  const preparation = await data.prepare(undefined, event => { if (event.progress?.kind === 'content' && event.progress.completed) phases.push(event.phase); });
  assert.deepEqual(phases, ['validating-input', 'final-validation']); assert.equal(preparation.tools[0].ok, true); assert.ok(!('verdict' in preparation));
});

test('changed input rejects Human preparation before readiness execution', async t => {
  const data = await fixture(t); await writeFile(join(data.repoPath, 'content.txt'), 'changed');
  await assert.rejects(data.prepare(), /workspace changed/i); await assert.rejects(readFile(data.marker), { code: 'ENOENT' });
});

test('a readiness script that mutates reviewed input invalidates preparation', async t => {
  const data = await fixture(t, true); await assert.rejects(data.prepare(), /workspace changed/i);
});

test('cancellation after acquisition prevents readiness scripts from executing', async t => {
  const data = await fixture(t), controller = new AbortController();
  await assert.rejects(data.prepare(controller.signal, progress => { if (progress.phase === 'checking-manifest') controller.abort(new Error('Fixture cancellation')); }), /Fixture cancellation/);
  await assert.rejects(readFile(data.marker), { code: 'ENOENT' });
});
