import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent } from '@ccdd/default-tools';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ToolContext } from '../src/sdk.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import type { StreamFn } from '../src/executors/pi.js';
import { prepareReviewRequests } from '../src/requester/index.js';
import { createReviewTools } from '../src/tools/runner.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

async function fixture(t: TestContext, directory = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-default-image-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = join(root, directory ? 'images' : 'preview.unknown');
  if (directory) await mkdir(artifactPath); else await writeFile(artifactPath, png);
  const outputDir = join(root, 'output'), temporary = join(root, 'temporary');
  await mkdir(outputDir);
  await mkdir(temporary);
  const abort = new AbortController();
  const context: ToolContext = {
    artifactId: 'preview', artifactPath, artifactDirectory: directory, outputDir, tmpDir: temporary, signal: abort.signal,
    async resolvePath(path = '') {
      if (!directory && path) throw new Error('A file artifact has no child paths');
      const target = join(artifactPath, path), sub = relative(artifactPath, target);
      if (isAbsolute(path) || sub === '..' || sub.startsWith(`..${sep}`)) throw new Error('Requested path escapes the artifact');
      // Deliberately leave symlink rejection to the independent CLI checks in these tests.
      await access(target);
      return target;
    },
  };
  return { root, artifactPath, context, abort };
}

test('default image factory explicitly declares image capability and Pi read returns actual image content independent of extension', async t => {
  const data = await fixture(t);
  const tool = agent.image.view();
  assert.deepEqual(tool.metadata.resultKinds, ['image']);
  assert.equal(tool.metadata.observation, 'content');
  assert.equal(tool.metadata.artifactKind, 'any');
  assert.match(tool.metadata.description, /\{artifactName\}/);
  assert.equal((await tool.preflight(data.context)).ok, true);
  assert.deepEqual(await tool.execute(data.context, {}), {
    content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
    observation: { kind: 'content' },
  });
  await writeFile(data.artifactPath, webp);
  assert.deepEqual((await tool.execute(data.context, {})).content, [{ type: 'image', data: webp.toString('base64'), mimeType: 'image/webp' }]);
  await assert.rejects(tool.execute(data.context, { path: 'another.png' }), /does not accept path/);
  await assert.rejects(tool.execute(data.context, { offset: 1 } as never), /Invalid artifact tool arguments/);
  assert.notEqual(agent.image.view().metadata, tool.metadata);
});

test('view_image rejects Pi text fallback and unsupported image formats without an observation result', async t => {
  const data = await fixture(t);
  const tool = agent.image.view();
  const animatedPng = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 8]), Buffer.from('acTL'), Buffer.alloc(12), png.subarray(33)]);
  for (const contents of [Buffer.from('not an image, even with a .png extension'), Buffer.from('GIF89a'), animatedPng, png.subarray(0, 8)]) {
    await writeFile(data.artifactPath, contents);
    assert.equal((await tool.preflight(data.context)).ok, true, 'Preparation checks readiness without reading or decoding content.');
    await assert.rejects(tool.execute(data.context, {}), /requires.*PNG.*JPEG.*WebP/);
  }
  await writeFile(data.artifactPath, '');
  await assert.rejects(tool.execute(data.context, {}), /contains no data/);
});

test('directory image paths stay within their Artifact and the CLI rejects symlinks and directories', async t => {
  const data = await fixture(t, true);
  await mkdir(join(data.artifactPath, 'nested'));
  const path = "nested/\ubbf8\ub9ac\ubcf4\uae30 8\u202fPM.png";
  await writeFile(join(data.artifactPath, path), png);
  await writeFile(join(data.root, 'outside.png'), png);
  await symlink('../outside.png', join(data.artifactPath, 'outside-link.png'));
  await symlink('nested', join(data.artifactPath, 'linked-directory'));
  const tool = agent.image.view();
  assert.deepEqual((await tool.execute(data.context, { path })).content, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
  await assert.rejects(tool.execute(data.context, {}), /requires an internal file path/);
  await assert.rejects(tool.execute(data.context, { path: 'nested' }), /regular file/);
  await assert.rejects(tool.execute(data.context, { path: '../outside.png' }), /safe internal relative path/);
  await assert.rejects(tool.execute(data.context, { path: '/outside.png' }), /safe internal relative path/);
  await assert.rejects(tool.execute(data.context, { path: 'outside-link.png' }), /symlink/);
  await assert.rejects(tool.execute(data.context, { path: "linked-directory/\ubbf8\ub9ac\ubcf4\uae30 8\u202fPM.png" }), /symlink/);
  assert.deepEqual(await readFile(join(data.root, 'outside.png')), png);
});

test('image CLI accepts the bounded 4 MiB image response and rejects oversized input before Pi reads it', async t => {
  const data = await fixture(t);
  const tool = agent.image.view();
  const padded = Buffer.alloc(4 * 1024 * 1024);
  png.copy(padded);
  await writeFile(data.artifactPath, padded);
  const result = await tool.execute(data.context, {});
  const image = result.content[0];
  assert.ok(image.type === 'image' && 'data' in image);
  assert.equal(Buffer.from(image.data, 'base64').length, padded.length);
  assert.equal(result.observation?.kind, 'content');
  await writeFile(data.artifactPath, Buffer.concat([padded, Buffer.from([0])]));
  await assert.rejects(tool.execute(data.context, {}), /4 MiB limit/);
});

test('default image tool preserves cancellation and process time limits', async t => {
  const data = await fixture(t);
  const before = { ...data.context, signal: AbortSignal.abort() };
  await assert.rejects(agent.image.view().execute(before, {}), /abort/i);
  await assert.rejects(agent.image.view({ timeoutMs: 1 }).execute(data.context, {}), /timed out/);
});

test('explicit default view_image registration reaches the scoped Runner and Pi Agent with an audited image observation', async t => {
  const data = await fixture(t);
  const repoPath = join(data.root, 'project');
  const defaultsRoot = fileURLToPath(new URL('../', import.meta.resolve('@ccdd/default-tools')));
  const sourceModules = resolve(defaultsRoot, '../../node_modules');
  const targetDefaults = join(repoPath, 'node_modules/@ccdd/default-tools');
  await mkdir(targetDefaults, { recursive: true });
  await cp(join(defaultsRoot, 'package.json'), join(targetDefaults, 'package.json'));
  await cp(join(defaultsRoot, 'dist'), join(targetDefaults, 'dist'), { recursive: true });
  // Physically copy the pinned Pi read runtime, without symlinks, mocks or the lazily loaded Provider SDKs.
  for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-telemetry', '@earendil-works/chord', 'typebox', 'diff', 'ignore', 'yaml', 'partial-json']) {
    await cp(join(sourceModules, name), join(repoPath, 'node_modules', name), {
      recursive: true, filter: source => !source.endsWith('.map') && !source.endsWith('.d.ts'),
    });
  }
  await writeFile(join(repoPath, 'preview.png'), png);
  await writeFile(join(repoPath, 'ccdd.config.ts'), `
import { agent } from '@ccdd/default-tools';
export default {
  artifacts: { preview: { type: 'image', path: 'preview.png' } },
  artifactTypes: { image: { agentTools: { view_image: agent.image.view() } } },
  critics: [{ id: 'image-review', title: 'Image review', target: 'preview', deps: [],
    profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 15000 },
    payload: { instruction: 'Inspect {preview}.' } }],
};
`);
  const [request] = await prepareReviewRequests({ repoPath, snapshotHash: 'a'.repeat(64), criticId: 'image-review' });
  assert.ok(request.configManifest);
  const registry = await createReviewTools({ ...request, worktreePath: repoPath, runDir: join(data.root, 'preflight'), audience: 'agent' });
  try {
    assert.equal(registry.tools[0].name, 'view_image_preview');
    assert.equal((await registry.preflight())[0].ok, true);
  } finally { await registry.close(); }
  let transport: ReturnType<typeof fauxProvider> | undefined;
  let sawImage = false, started = false;
  const streamFn: StreamFn = (model, context, options) => {
    transport ??= fauxProvider({ provider: model.provider, api: model.api });
    for (const message of context.messages) if (message.role === 'toolResult') {
      assert.equal(message.isError, false);
      assert.deepEqual(message.content, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
      sawImage = true;
    }
    if (!started) {
      assert.deepEqual(context.tools?.map(tool => tool.name), ['view_image_preview']);
      started = true;
      transport.appendResponses([
        fauxAssistantMessage([fauxToolCall('view_image_preview', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage(JSON.stringify({ verdict: 'GREEN', summary: 'Image inspected.', evidence: ['Viewed the registered preview image.'] })),
      ]);
    }
    return transport.provider.streamSimple(model, context, options);
  };
  const result = await createExecutorRegistry({ streamFn }).execute(request, { worktreePath: repoPath, runDir: join(data.root, 'review') });
  assert.equal(sawImage, true);
  assert.equal(result.verdict, 'GREEN');
  assert.deepEqual(result.toolCalls?.[0].observation, { artifactId: 'preview', operation: 'view_image', kind: 'content' });
  assert.doesNotMatch(JSON.stringify(result), /iVBOR|preview\.png/);
});
