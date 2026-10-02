import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';
import { readArtifactConfig, readWorkspaceConfig } from '../src/broker/config.js';
import { createProjectSnapshot } from '../src/project/index.js';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { projectRun } from '../src/project/store.js';
import { diagnoseArtifactTools } from '../src/artifacts/tool-check.js';
import { runResultCheck } from '../src/executors/result-check.js';
import { resolveScopePath } from '../src/artifact-scope.js';
import { groupFamilies } from '../src/monitor/ui/family-groups.js';
import type { ArtifactManifest } from '../src/sdk.js';
import type { GraphProjection } from '../src/broker/graph.js';

// Each instance reads its own material through the shared script.
const familyView = `import {readFileSync} from 'node:fs'; import {join} from 'node:path';
let text=''; for await (const chunk of process.stdin) text+=chunk;
const request=JSON.parse(text), family=request.context.scope[request.context.artifactId].family;
process.stdout.write(JSON.stringify({content:[{type:'json',data:{artifactId:request.context.artifactId,family,text:readFileSync(join(request.context.artifactPath,family.material[0]),'utf8'),args:request.args}}],observation:{kind:'content'}}));
`;
const template = (instances: unknown, extra: Record<string, unknown> = {}): ArtifactManifest => ({
  name: 'scenarios', family: { instances },
  views: { agentTools: { read: {
    metadata: { description: 'Read {artifactName}.', inputSchema: { type: 'object', properties: { id: { type: 'string', enum: { $param: '/ids' } } }, required: ['id'], additionalProperties: false }, resultKinds: ['json'], observation: 'content' },
    script: { command: 'node', args: ['family-view.mjs'] },
  } } },
  critics: [{ ...runtimeCritic('review'), payload: { instruction: { $param: '/instruction' } } }],
  ...extra,
} as unknown as ArtifactManifest);
const instances = {
  a: { params: { ids: ['x', 'y'], instruction: 'Inspect {a}.' }, material: ['a.txt'] },
  b: { params: { ids: ['z'], instruction: 'Inspect {b} against {rules}.' }, material: ['b.txt'] },
};
async function familyFixture(t: Parameters<typeof artifactFixture>[0], folder = 'scenarios', extra: Record<string, unknown> = {}) {
  const data = await artifactFixture(t);
  await data.write('rules', { name: 'rules', basis: true });
  await data.write(folder, template('instances.json', extra), { 'family-view.mjs': familyView, 'instances.json': JSON.stringify(instances), 'a.txt': 'one', 'b.txt': 'two' });
  return data;
}
const hashes = async (data: Awaited<ReturnType<typeof familyFixture>>) => (await createProjectSnapshot(await data.config(), data.repoPath, 'a'.repeat(64))).artifactHashes;

test('a family declares statically listed instances that share one folder, views and Critics', async t => {
  const data = await familyFixture(t), config = await data.config();
  assert.deepEqual(Object.keys(config.artifacts).sort(), ['a', 'b', 'rules']);
  for (const [id, material] of [['a', 'a.txt'], ['b', 'b.txt']]) {
    assert.equal(config.artifacts[id].path, 'scenarios');
    assert.deepEqual({ ...config.artifacts[id].family, entry: undefined }, { name: 'scenarios', instances: 'instances.json', material: [material], entry: undefined });
  }
  assert.deepEqual((config.artifacts.a.views.agentTools!.read.metadata.inputSchema as any).properties.id.enum, ['x', 'y']);
  assert.deepEqual((config.artifacts.b.views.agentTools!.read.metadata.inputSchema as any).properties.id.enum, ['z']);
  const critics = Object.fromEntries(config.critics.map(critic => [critic.id, critic]));
  assert.deepEqual(Object.keys(critics).sort(), ['a/review', 'b/review']);
  assert.equal(critics['b/review'].payload.instruction, 'Inspect {b} against {rules}.');
  assert.deepEqual(critics['b/review'].deps, ['rules']);
  assert.deepEqual(config.relations.filter(relation => relation.kind === 'instruction'), [{ source: 'rules', target: 'b', kind: 'instruction', criticId: 'b/review' }]);
  assert.deepEqual(config.configManifest.declarations.map(value => value.path).sort(), ['rules/ccdd.json', 'scenarios/ccdd.json', 'scenarios/instances.json']);
});

test('family declarations reject ambiguous names, nesting and unresolved parameters', async t => {
  const cases: [string, (data: Awaited<ReturnType<typeof artifactFixture>>) => Promise<unknown>, RegExp][] = [
    ['mounting the family', data => data.write('user', { name: 'user', basis: true, mounts: { all: 'scenarios' } }), /is an Artifact family; mount one of its instances/],
    ['referencing the family', data => data.write('user', { name: 'user', critics: [runtimeCritic('check', 'Inspect {scenarios}.')] }), /names an Artifact family; reference one of its instances/],
    ['an instance reusing a name', data => data.write('a', { name: 'a', basis: true }), /Duplicate Artifact name: a/],
    ['a nested marker', data => data.write('scenarios/inner', { name: 'inner', basis: true }), /Artifact family scenarios cannot contain nested ccdd\.json markers/],
    ['a parameter outside a family', data => data.write('user', { name: 'user', critics: [{ ...runtimeCritic(), payload: { instruction: { $param: '/x' } } } as any] }), /\$param references are allowed only in an Artifact family declaration/],
    ['a missing parameter', data => writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, c: { params: { ids: ['w'] } } })), /instance c: Instance c has no parameter at \/instruction/],
    ['an invalid pointer escape', data => writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, a: { ...instances.a, params: { ...instances.a.params, 'bad~2': 1 } } })).then(() => data.edit('scenarios', manifest => { (manifest.critics![0].payload as any).weight = { $param: '/bad~2' }; })), /\$param must be a JSON Pointer/],
    ['an instance shadowing a physical entry', data => mkdir(join(data.repoPath, 'scenarios/a')), /Instance a conflicts with a physical entry in its family folder/],
  ];
  for (const [label, change, expected] of cases) await t.test(label, async t => {
    const data = await familyFixture(t);
    await change(data);
    await assert.rejects(data.config(), expected);
  });
  await t.test('a root family', async t => {
    const data = await artifactFixture(t);
    await data.write('', template({ a: {} }));
    await assert.rejects(data.config(), /cannot be the workspace root/);
  });
});

test('a parent depends on each instance as a logical child below the family folder', async t => {
  const data = await familyFixture(t, 'docs/scenarios');
  await data.write('docs', { name: 'docs', basis: true });
  const config = await data.config();
  assert.deepEqual(config.artifacts.docs.children, { 'scenarios/a': 'a', 'scenarios/b': 'b' });
  const scope = Object.fromEntries(Object.entries(config.artifacts).map(([id, artifact]) => [id, artifact]));
  assert.deepEqual(resolveScopePath(scope, 'docs', 'scenarios/b/b.txt'), { artifactId: 'b', path: 'b.txt' });
  // The family folder belongs to its instances; the parent cannot read it under its own identity.
  for (const path of ['scenarios', 'scenarios/a.txt']) assert.throws(() => resolveScopePath(scope, 'docs', path), /inside the folder of Artifact family scenarios/);
  assert.deepEqual(resolveScopePath(scope, 'docs', 'content.txt'), { artifactId: 'docs', path: 'content.txt' });
  // The default listing names the instances, and each listed path is navigable.
  const { scriptRequest } = await import('@ccdd/default-tools/cli');
  const request = (args: Record<string, unknown>) => ({ version: 1 as const, context: { artifactId: 'docs', artifactPath: config.artifacts.docs.path, outputDir: data.root, tmpDir: data.root,
    scope: Object.fromEntries(Object.entries(config.artifacts).map(([id, artifact]) => [id, { path: join(data.repoPath, artifact.path), children: artifact.children, mounts: artifact.mounts, ...(artifact.family ? { family: artifact.family } : {}) }])) }, args });
  const listing = await scriptRequest('list', { ...request({}), context: { ...request({}).context, artifactPath: join(data.repoPath, 'docs') } });
  const entries = (listing.content[0] as unknown as { data: { entries: { name: string; kind: string; instances?: string[] }[] } }).data.entries;
  assert.deepEqual(entries.find(entry => entry.name === 'scenarios'), { name: 'scenarios', kind: 'family', instances: ['a', 'b'], path: 'scenarios' });
  const read = await scriptRequest('read', { ...request({ path: 'scenarios/a/a.txt' }), context: { ...request({}).context, artifactPath: join(data.repoPath, 'docs') } });
  assert.equal((read.content[0] as unknown as { data: { resolvedArtifactId: string } }).data.resolvedArtifactId, 'a');
  const before = await hashes(data);
  await writeFile(join(data.repoPath, 'docs/content.txt'), 'changed parent');
  const parent = await hashes(data);
  assert.notEqual(parent.docs, before.docs); assert.equal(parent.a, before.a); assert.equal(parent.b, before.b);
  await writeFile(join(data.repoPath, 'docs/scenarios/a.txt'), 'changed instance');
  const child = await hashes(data);
  assert.notEqual(child.a, parent.a); assert.notEqual(child.docs, parent.docs); assert.equal(child.b, parent.b);
});

test('each instance identity covers shared material, its entry and its own material only', async t => {
  const data = await familyFixture(t);
  const initial = await hashes(data);
  await writeFile(join(data.repoPath, 'scenarios/a.txt'), 'one, revised');
  const material = await hashes(data);
  assert.notEqual(material.a, initial.a); assert.equal(material.b, initial.b);
  const c = { params: { ids: ['w'], instruction: 'Inspect {c}.' }, material: ['c.txt'] };
  await writeFile(join(data.repoPath, 'scenarios/c.txt'), 'three');
  await writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ c, ...instances }));
  const added = await hashes(data);
  assert.equal(added.a, material.a); assert.equal(added.b, material.b); assert.ok(added.c);
  await writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, c, b: { ...instances.b, params: { ...instances.b.params, ids: ['z', 'q'] } } }));
  const parameters = await hashes(data);
  assert.equal(parameters.a, material.a); assert.equal(parameters.c, added.c); assert.notEqual(parameters.b, material.b);
  // Unlisted material is shared again: it belongs to every remaining instance.
  await writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, b: { ...instances.b, params: { ...instances.b.params, ids: ['z', 'q'] } } }));
  const removed = await hashes(data);
  assert.notEqual(removed.a, parameters.a); assert.equal(removed.c, undefined);
  await rm(join(data.repoPath, 'scenarios/c.txt'));
  assert.equal((await hashes(data)).a, parameters.a);
  await writeFile(join(data.repoPath, 'scenarios/family-view.mjs'), `${familyView}// revised\n`);
  const shared = await hashes(data);
  assert.notEqual(shared.a, parameters.a); assert.notEqual(shared.b, parameters.b);
  await data.edit('scenarios', manifest => { manifest.critics![0].title = 'Revised title'; });
  const declaration = await hashes(data);
  assert.notEqual(declaration.a, shared.a); assert.notEqual(declaration.b, shared.b);
});

test('nested instance material and narrowed shared paths never reach sibling identities', async t => {
  const data = await familyFixture(t);
  const initial = await hashes(data);
  // A new instance stores its material in a new directory.
  await mkdir(join(data.repoPath, 'scenarios/states/c'), { recursive: true });
  await writeFile(join(data.repoPath, 'scenarios/states/c/state.txt'), 'three');
  await writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, c: { params: { ids: ['w'], instruction: 'Inspect {c}.' }, material: ['states/c/state.txt'] } }));
  const added = await hashes(data);
  assert.equal(added.a, initial.a); assert.equal(added.b, initial.b);
  // Unlisted content in that directory is shared material again.
  await writeFile(join(data.repoPath, 'scenarios/states/shared.txt'), 'shared');
  const shared = await hashes(data);
  assert.notEqual(shared.a, added.a); assert.notEqual(shared.c, added.c);

  // Declared folders above instance material are stable whether missing, empty or filled.
  const transitions = await familyFixture(t);
  await writeFile(join(transitions.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, b: { ...instances.b, material: ['states/b.txt'] } }));
  const absent = await hashes(transitions);
  await mkdir(join(transitions.repoPath, 'scenarios/states'));
  const empty = await hashes(transitions);
  await writeFile(join(transitions.repoPath, 'scenarios/states/b.txt'), 'two');
  const filled = await hashes(transitions);
  assert.equal(empty.a, absent.a); assert.equal(filled.a, absent.a); assert.notEqual(filled.b, empty.b);
  await mkdir(join(transitions.repoPath, 'scenarios/unrelated'));
  assert.notEqual((await hashes(transitions)).a, filled.a);

  const narrowed = await familyFixture(t, 'scenarios', { stale: { kind: 'file-hash', paths: ['family-view.mjs', 'a.txt', 'b.txt'] } });
  const before = await hashes(narrowed);
  await writeFile(join(narrowed.repoPath, 'scenarios/b.txt'), 'two, revised');
  const edited = await hashes(narrowed);
  assert.equal(edited.a, before.a); assert.notEqual(edited.b, before.b);
  await rm(join(narrowed.repoPath, 'scenarios/b.txt'));
  const missing = await hashes(narrowed);
  assert.equal(missing.a, before.a); assert.notEqual(missing.b, edited.b);
});

test('reconnecting a recorded instance expands only that instance', async t => {
  const data = await familyFixture(t), config = await data.config();
  // An invalid sibling entry is not expanded while reconnecting a recorded scope.
  await writeFile(join(data.repoPath, 'scenarios/instances.json'), JSON.stringify({ ...instances, c: { params: { ids: ['w'] } } }));
  const { config: scoped } = await readArtifactConfig(data.repoPath, { a: config.artifacts.a });
  assert.deepEqual(Object.keys(scoped.artifacts), ['a']);
  assert.deepEqual(scoped.artifacts.a, config.artifacts.a);
  await assert.rejects(data.config(), /instance c/);
});

test('inline instances keep other instances valid when the list grows', async t => {
  const data = await artifactFixture(t);
  await data.write('rules', { name: 'rules', basis: true });
  await data.write('scenarios', template(instances), { 'family-view.mjs': familyView, 'a.txt': 'one', 'b.txt': 'two' });
  const before = await hashes(data);
  await data.edit('scenarios', manifest => { (manifest.family!.instances as Record<string, unknown>).c = { params: { ids: ['w'], instruction: 'Inspect {c}.' } }; });
  const after = await hashes(data);
  assert.equal(after.a, before.a); assert.equal(after.b, before.b); assert.ok(after.c);
  assert.equal((await data.config()).artifacts.a.family!.instances, undefined);
});

test('actual reviews of unchanged instances are reused when a sibling changes', async t => {
  const data = await familyFixture(t), broker = createBroker({ detail: 'full', ...data, executors: createExecutorRegistry() });
  data.cleanup(() => broker.close());
  const verify = async () => {
    const run = await broker.submitProject({ selection: { kind: 'all' } });
    if (run.status !== 'GREEN') await broker.run(run.id);
    return projectRun(data.stateDir, run.id)!;
  };
  const first = await verify();
  assert.equal(first.status, 'GREEN'); assert.deepEqual(first.requests.map(request => request.criticId).sort(), ['a/review', 'b/review']);
  await writeFile(join(data.repoPath, 'scenarios/b.txt'), 'two, revised');
  const second = await verify();
  assert.equal(second.status, 'GREEN'); assert.deepEqual(second.requests.map(request => request.criticId), ['b/review']);
  const reused = second.validation!.items.find(item => item.id === 'a/review')!;
  assert.equal(reused.action, 'REUSE'); assert.equal(reused.result!.requestId, first.requests.find(request => request.criticId === 'a/review')!.id);
});

test('shared view scripts receive the instance and its material, with instance-specific schemas', async t => {
  const data = await familyFixture(t);
  const run = await diagnoseArtifactTools({ ...data, artifactId: 'b', audience: 'agent', toolName: 'read', execute: true, arguments: { id: 'z' } });
  assert.equal(run.ok, true, JSON.stringify(run.checks));
  const block = run.result!.content[0] as { type: 'json'; data: any };
  assert.deepEqual(block.data, { artifactId: 'b', family: { name: 'scenarios', material: ['b.txt'] }, text: 'two', args: { id: 'z' } });
  const rejected = await diagnoseArtifactTools({ ...data, artifactId: 'b', audience: 'agent', toolName: 'read', execute: true, arguments: { id: 'x' } });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.checks.some(check => check.code === 'ARTIFACT_TOOL_ARGUMENTS_INVALID'));
});

test('one shared identity script computes each instance value from its stdin', async t => {
  const identity = `import {readFileSync} from 'node:fs';
let text=''; for await (const chunk of process.stdin) text+=chunk;
const input=JSON.parse(text);
process.stdout.write(input.artifactId+'-'+readFileSync(input.family.material[0],'utf8')+'\\n');
`;
  const data = await familyFixture(t, 'scenarios', { stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } } });
  await writeFile(join(data.repoPath, 'scenarios/identity.mjs'), identity);
  const snapshot = await createProjectSnapshot(await data.config(), data.repoPath, 'a'.repeat(64));
  assert.deepEqual(snapshot.artifactIdentities, { a: { identity: 'script', value: 'a-one' }, b: { identity: 'script', value: 'b-two' } });
});

test('a shared result check receives the reviewed instance', async t => {
  const data = await familyFixture(t);
  await writeFile(join(data.repoPath, 'scenarios/check.mjs'), `let text=''; for await (const chunk of process.stdin) text+=chunk;
const input=JSON.parse(text); process.stdout.write(JSON.stringify({errors:[input.artifactId+':'+input.family.name+':'+input.family.material.join(',')]}));\n`);
  const config = await data.config(), runDir = join(data.root, 'run');
  await mkdir(runDir);
  const errors = await runResultCheck({ worktreePath: data.repoPath, ownerPath: 'scenarios', artifactId: 'b', family: config.artifacts.b.family, check: { script: 'check.mjs' }, result: { verdict: 'GREEN' }, toolCalls: [], runDir });
  assert.deepEqual(errors, ['b:scenarios:b.txt']);
});

test('the monitor collapses each family into one node until it is expanded', () => {
  const state = (id: string, status: GraphProjection['artifacts'][number]['status'], family?: string) => ({ id, path: family ? 'scenarios' : id, basis: false, status, mounts: {}, children: {}, criticIds: [`${id}/review`], passed: status === 'GREEN' ? 1 : 0, total: 1, included: 1, ...(family ? { family } : {}) });
  const graph: GraphProjection = { critics: [],
    artifacts: [state('a', 'GREEN', 'scenarios'), state('b', 'RED', 'scenarios'), state('report', 'UNREVIEWED')],
    edges: [
      { source: 'a', target: 'report', criticIds: ['report/check'], relations: [{ source: 'a', target: 'report', kind: 'instruction', criticId: 'report/check' }], cyclic: false },
      { source: 'b', target: 'report', criticIds: ['report/check'], relations: [{ source: 'b', target: 'report', kind: 'instruction', criticId: 'report/check' }], cyclic: false },
      { source: 'a', target: 'b', criticIds: [], relations: [{ source: 'a', target: 'b', kind: 'mount', name: 'peer' }], cyclic: false },
    ] };
  const collapsed = groupFamilies(graph);
  assert.deepEqual(collapsed.artifacts.map(artifact => [artifact.id, artifact.status, artifact.passed, artifact.total]), [['report', 'UNREVIEWED', 0, 1], ['scenarios', 'RED', 1, 2]]);
  assert.deepEqual(collapsed.edges.map(edge => [edge.source, edge.target, edge.criticIds, edge.relations.length]), [['scenarios', 'report', ['report/check'], 2]]);
  assert.equal(collapsed.nodeOf('b'), 'scenarios'); assert.equal(collapsed.nodeOf('report'), 'report');
  const expanded = groupFamilies(graph, new Set(['scenarios']));
  assert.deepEqual(expanded.artifacts.map(artifact => artifact.id), ['a', 'b', 'report']);
  assert.equal(expanded.edges.length, 3); assert.equal(expanded.groups.size, 0);
});
