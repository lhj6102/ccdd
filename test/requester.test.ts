import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews, agentProfile, runtimeCritic } from './helpers/artifacts.js';
import { readWorkspaceConfig } from '../src/broker/config.js';
import { instructionReferences, parseArtifactInstruction, digestArtifactInstruction } from '../src/artifacts/instruction.js';
import { resolveScopePath } from '../src/artifact-scope.js';
import { createGraphDefinition, stronglyConnectedComponents } from '../src/broker/graph.js';
import { createBroker } from '../src/broker/index.js';

const review = (instruction = 'Inspect {spec}.') => ({ id: 'style', title: 'Inspect', profile: agentProfile, payload: { instruction } });

test('folder declarations discover nearest children without merging owned Critics or views', async t => {
  const data = await artifactFixture(t);
  await data.write('', { name: 'root', basis: true });
  await data.write('docs/spec', { name: 'spec', views: fixtureViews(), critics: [review()] });
  await data.write('docs/spec/examples/deep', { name: 'example' });
  const config = await data.config();
  assert.equal(config.artifacts.root.path, '');
  assert.deepEqual(config.artifacts.root.children, { 'docs/spec': 'spec' });
  assert.deepEqual(config.artifacts.spec.children, { 'examples/deep': 'example' });
  assert.deepEqual(config.artifacts.root.views, {});
  assert.deepEqual(config.critics.map(c => [c.id, c.target]), [['spec/style', 'spec']]);
  const [request] = await data.requests('spec/style');
  assert.deepEqual(request.artifacts.map(a => a.id), ['spec', 'example']);
  assert.deepEqual(request.requiredObservations, ['spec']);
  assert.equal(request.configManifest.version, 2);
});

test('discovery excludes installed packages, Git internals and symlink directories without executing global config', async t => {
  const data = await artifactFixture(t), marker = join(data.root, 'executed');
  await data.write('spec', { name: 'spec' });
  for (const folder of ['.git/objects', 'node_modules/package']) {
    await mkdir(join(data.repoPath, folder), { recursive: true }); await writeFile(join(data.repoPath, folder, 'ccdd.json'), '{invalid');
  }
  await symlink('spec', join(data.repoPath, 'linked'));
  await writeFile(join(data.repoPath, 'ccdd.config.ts'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');throw new Error('legacy');`);
  assert.deepEqual(Object.keys((await data.config()).artifacts), ['spec']);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('legacy global declarations do not define any Artifact', async t => {
  const data = await artifactFixture(t);
  await writeFile(join(data.repoPath, 'ccdd.config.json'), '{"artifacts":{}}');
  await assert.rejects(data.config(), /at least one ccdd.json/);
});

test('duplicate names, duplicate local Critics, unknown fields and symlink markers fail statically', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'spec' }); await data.write('b', { name: 'spec' });
  await assert.rejects(data.config(), /Duplicate Artifact/);
  await data.edit('b', m => { m.name = 'other'; m.critics = [runtimeCritic(), runtimeCritic()]; });
  await assert.rejects(data.config(), /Duplicate local Critic/);
  await data.edit('b', m => { m.critics = [runtimeCritic()]; Reflect.set(m.critics[0], 'target', 'spec'); });
  await assert.rejects(data.config(), /Unknown Critic field: target/);
  await data.edit('b', m => { m.critics = []; Reflect.set(m, 'artifactTypes', {}); });
  await assert.rejects(data.config(), /Unknown Artifact field/);
});

test('mount aliases share canonical identity and Critic references produce dependencies without duplicate declarations', async t => {
  const data = await artifactFixture(t);
  await data.write('style', { name: 'coding-style', basis: true, views: fixtureViews() });
  await data.write('spec', { name: 'spec', views: fixtureViews(), mounts: { style: 'coding-style', guide: 'coding-style' }, critics: [review('Use {style}, {guide} and {coding-style} to evaluate {spec}.')] });
  const config = await data.config(), [request] = await data.requests();
  assert.equal(request.criticId, 'spec/style'); assert.deepEqual(request.deps, ['coding-style']);
  assert.deepEqual(request.references, { style: 'coding-style', guide: 'coding-style', 'coding-style': 'coding-style', spec: 'spec' });
  assert.equal(request.artifacts.filter(a => a.id === 'coding-style').length, 1);
  const instruction = digestArtifactInstruction(request.payload.instruction, request.artifacts, [{ name: 'read_coding-style', artifactId: 'coding-style' }], request.references);
  assert.equal(instruction.split('read_coding-style').length - 1, 3);
  assert.equal(config.relations.filter(edge => edge.kind === 'mount').length, 2);
});

test('unresolved references and ambiguous mount aliases are configuration errors', async t => {
  const data = await artifactFixture(t);
  await data.write('spec', { name: 'spec', views: fixtureViews(), critics: [review('Read {missing}.')] });
  await assert.rejects(data.config(), /Unknown Artifact reference/);
  await data.edit('spec', m => { m.critics = []; m.mounts = { missing: 'absent' }; });
  await assert.rejects(data.config(), /Unknown mount target/);
  await data.write('style', { name: 'style' });
  await data.edit('spec', m => { m.mounts = { style: 'spec' }; });
  await assert.rejects(data.config(), /Ambiguous mount alias/);
  await data.edit('spec', m => { m.mounts = { 'content': 'style' }; });
  await mkdir(join(data.repoPath, 'spec/content'));
  await assert.rejects(data.config(), /conflicts with a physical entry/);
});

test('instruction escaping retains existing literals and binds aliases to canonical tool audiences', () => {
  const input = 'Use {alias}, \\{missing}, {{literal}}, ${variable}, {"json":1}, and {self}.';
  assert.deepEqual(instructionReferences(input), ['alias', 'self']);
  const parts = parseArtifactInstruction(input, [{ id: 'spec' }], { alias: 'spec', self: 'spec' });
  assert.equal(parts.filter(part => part.type === 'artifact').length, 2);
  assert.match(digestArtifactInstruction('{alias}', [{ id: 'spec' }], [{ name: 'open_spec', artifactId: 'spec' }], { alias: 'spec' }), /open_spec/);
});

test('logical paths traverse nested folders and cycles finitely without creating filesystem links', () => {
  const scope = { a: { path: '/a', children: { 'nested/child': 'b' }, mounts: { peer: 'b' } }, b: { path: '/b', children: {}, mounts: { back: 'a' } } };
  assert.deepEqual(resolveScopePath(scope, 'a', 'peer/back/peer/file.txt'), { artifactId: 'b', path: 'file.txt' });
  assert.deepEqual(resolveScopePath(scope, 'a', 'nested/child/file.txt'), { artifactId: 'b', path: 'file.txt' });
  for (const path of ['../secret', '/secret', 'peer/../file', 'C:/file', 'peer\\file']) assert.throws(() => resolveScopePath(scope, 'a', path));
});

test('cycles and unevaluated dependencies are accepted while audience requirements stay local to explicit references', async t => {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', mounts: { peer: 'b' }, critics: [runtimeCritic()] });
  await data.write('b', { name: 'b', mounts: { peer: 'a' } });
  const config = await data.config();
  assert.deepEqual(stronglyConnectedComponents(Object.keys(config.artifacts), config.relations), [['a', 'b']]);
  assert.doesNotThrow(() => createGraphDefinition(config));
  await data.edit('a', m => { m.views = fixtureViews(); m.critics = [review('Inspect {a}.')]; });
  await data.requests('a/style');
  await data.edit('a', m => { m.critics![0].payload.instruction = 'Inspect {a} and {peer}.'; });
  await assert.rejects(data.requests('a/style'), /b has no agent views/);
});

test('invalid configuration is rejected before tickets or Provider readiness checks', async t => {
  const data = await artifactFixture(t); await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  await data.edit('a', m => { Reflect.set(m, 'sources', {}); });
  let readiness = 0;
  const broker = createBroker({ ...data, executors: { canExecute: () => { readiness++; return { ok: true }; }, execute: async () => { throw new Error('Must not execute.'); } } });
  data.cleanup(() => broker.close());
  await assert.rejects(broker.submitProject({ selection: { kind: 'all' } }), /Unknown Artifact field/);
  assert.equal(readiness, 0); assert.deepEqual(broker.listRuns(), []);
  await assert.rejects(readWorkspaceConfig(join(data.repoPath, 'missing')), { code: 'ENOENT' });
});
