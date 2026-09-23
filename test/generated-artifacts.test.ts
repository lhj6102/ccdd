import { runUntilSettled } from './helpers/run.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker } from '../src/broker/index.js';
import { readWorkspaceConfig } from '../src/broker/config.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { inspectProject, projectHistory, queryProject } from '../src/project/index.js';
import { prepareArtifactInputs } from '../src/artifacts/sources.js';
import { resolveArtifactScope } from '../src/artifacts/groups.js';
import { createReviewTools } from '../src/tools/runner.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import type { ArtifactSourceMetadata, JsonValue } from '../src/tools/contracts.js';

interface FixtureOptions {
  preparation?: ArtifactSourceMetadata['preparation'];
  identityKind?: ArtifactSourceMetadata['identity']['kind'];
  namespace?: string;
  version?: string;
  always?: boolean;
  resultExpression?: string;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-generated-artifacts-'));
  const repoPath = join(root, 'repo'), stateDir = join(root, 'state'), forbidPreparation = join(root, 'forbid-preparation');
  await mkdir(repoPath);
  const original: JsonValue = { summary: 'Scenario A', details: { evidence: ['first', 'second'], hidden: 'accepted' } };
  const saveData = (id: string, data: JsonValue) => writeFile(join(repoPath, `${id}.json`), JSON.stringify(data));
  await saveData('alpha', original);
  await saveData('beta', { summary: 'Independent scenario', details: { hidden: 'unchanged' } });
  const writeConfig = async (changes: FixtureOptions = {}) => {
    Object.assign(options, changes);
    const identity = { kind: options.identityKind ?? 'canonical-data', namespace: options.namespace ?? 'scenario', version: options.version ?? '1' };
    await writeFile(join(repoPath, 'ccdd.config.ts'), `
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const inspect = {
  metadata: { description: 'Inspect captured {artifactName}.', inputSchema: { type: 'object', properties: { summaryOnly: { type: 'boolean' } }, additionalProperties: false }, resultKinds: ['json'], observation: 'content', artifactKind: 'data' },
  preflight(context) {
    if ('artifactPath' in context || 'resolvePath' in context) throw new Error('Data tools must not receive filesystem Artifact paths.');
    context.readData().summary = 'Preflight-local mutation';
    return { ok: true, message: 'Captured data is available.' };
  },
  execute(context, args) {
    const changed = context.readData();
    changed.summary = 'Tool-local mutation';
    const data = context.readData();
    if (data.summary === changed.summary) throw new Error('readData must return independent copies.');
    return { content: [{ type: 'json', data: args.summaryOnly ? { summary: data.summary } : data }], observation: { kind: 'content' } };
  }
};
export default {
  artifacts: {
    alpha: { kind: 'generated', type: 'scenario', source: 'scenario', params: { file: 'alpha.json' }${options.always ? ", stale: { kind: 'always' }" : ''} },
    beta: { kind: 'generated', type: 'scenario', source: 'scenario', params: { file: 'beta.json' } },
    pair: { kind: 'group', members: ['alpha', 'beta'] }
  },
  artifactSources: { scenario: {
    metadata: ${JSON.stringify({ identity, preparation: options.preparation ?? 'read-only' })},
    async prepare({ params, resolvePath }) {
      if (existsSync(${JSON.stringify(forbidPreparation)})) throw new Error('Preparation was called unexpectedly.');
      const data = JSON.parse(await readFile(await resolvePath(params.file), 'utf8'));
      return ${options.resultExpression ?? (identity.kind === 'immutable-revision' ? '{ data, revision: data.summary }' : '{ data }')};
    }
    ${identity.kind === 'custom' ? ', fingerprint(data) { return JSON.stringify(data); }' : ''}
  } },
  artifactTypes: { scenario: { humanTools: { inspect }, agentTools: { inspect } } },
  critics: ['alpha', 'beta'].map(id => ({ id: id + '-review', title: 'Review ' + id, target: id, deps: [], profile: { kind: 'human' }, payload: { instruction: 'Inspect the complete scenario and submit a judgment.' } }))
};
`);
  };
  await writeConfig();
  const brokers: ReturnType<typeof createBroker>[] = [];
  const open = (workspaceIntegrity: 'content' | 'metadata' = 'content') => {
    const broker = createBroker({ repoPath, stateDir, workspaceIntegrity, executors: createExecutorRegistry({ alarmMethods: [async () => {}] }) });
    brokers.push(broker);
    return broker;
  };
  t.after(async () => { for (const broker of brokers) await broker.close(); await removeOwnedWorkspaceTree(root); });
  const inspect = () => inspectProject({ repoPath, stateDir });
  return { root, repoPath, stateDir, forbidPreparation, original, saveData, writeConfig, open, inspect };
}

async function humanReview(broker: ReturnType<typeof createBroker>, artifactId: string, verdict: 'GREEN' | 'RED', force = false) {
  const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId }, force });
  assert.equal(run.requests.length, 1);
  await runUntilSettled(broker, run.id);
  const request = broker.getRun(run.id)!.requests[0];
  assert.equal(request.status, 'WAITING_HUMAN');
  await broker.claimHuman(request.id, 'fixture-reviewer');
  const observed = await broker.executeHumanTool(request.id, { reviewerId: 'fixture-reviewer', toolName: `inspect_${artifactId}` });
  await broker.completeHuman(request.id, { reviewerId: 'fixture-reviewer', result: {
    verdict, summary: `Fixture Human submitted ${verdict} after inspecting captured data.`, evidence: [JSON.stringify(observed.content[0].data)],
  } });
  return broker.getRun(run.id)!;
}

test('generated Artifact capture and evidence reuse remain isolated by workspace integrity policy', async t => {
  const f = await fixture(t);
  const metadataBroker = f.open('metadata');
  const completed = await humanReview(metadataBroker, 'alpha', 'GREEN');
  assert.equal(completed.workspace.integrity, 'metadata');
  const metadata = await inspectProject({ repoPath: f.repoPath, stateDir: f.stateDir, workspaceIntegrity: 'metadata' });
  const strict = await f.inspect();
  assert.deepEqual(metadata.snapshot.config.artifactInputs?.alpha.data, f.original);
  assert.equal(metadata.snapshot.artifactHashes.alpha, strict.snapshot.artifactHashes.alpha);
  assert.notEqual(metadata.snapshot.inputs['alpha-review'].key, strict.snapshot.inputs['alpha-review'].key);
  assert.equal(metadata.plan.critics.find(critic => critic.id === 'alpha-review')?.status, 'PASS');
  assert.equal(strict.plan.critics.find(critic => critic.id === 'alpha-review')?.needsReview, true);
  const reused = await metadataBroker.submitProject({ selection: { kind: 'artifact', artifactId: 'alpha' } });
  assert.equal(reused.status, 'GREEN');
  assert.equal(reused.requests.length, 0);
  const strictBroker = f.open();
  const strictRun = await humanReview(strictBroker, 'alpha', 'GREEN');
  assert.equal(strictRun.workspace.integrity, undefined);
  assert.equal((await f.inspect()).plan.critics.find(critic => critic.id === 'alpha-review')?.status, 'PASS');
});

test('config loading never prepares generated material and explicit inspection creates no stored review state', async t => {
  const f = await fixture(t);
  await writeFile(f.forbidPreparation, 'Config loading must not prepare.');
  const loaded = await readWorkspaceConfig(f.repoPath);
  assert.equal(loaded.config.artifactInputs, undefined);
  assert.deepEqual(loaded.config.configManifest?.sources?.scenario.identity, { kind: 'canonical-data', namespace: 'scenario', version: '1' });
  await unlink(f.forbidPreparation);
  const first = await f.inspect(), second = await f.inspect();
  assert.equal(first.plan.satisfied, false);
  assert.deepEqual(first.snapshot.inputs, second.snapshot.inputs);
  assert.deepEqual(first.snapshot.config.artifactInputs?.alpha.data, f.original);
  assert.equal(await stat(f.stateDir).then(() => true, () => false), false);
});

test('canonical generated identities include unread evidence while preserving independent scenarios and group composition', async t => {
  const f = await fixture(t);
  const before = await f.inspect();
  await saveReordered();
  const equivalent = await f.inspect();
  assert.equal(before.snapshot.inputs['alpha-review'].key, equivalent.snapshot.inputs['alpha-review'].key);
  assert.equal(before.snapshot.artifactHashes.pair, equivalent.snapshot.artifactHashes.pair);
  await f.saveData('alpha', { summary: 'Scenario A', details: { evidence: ['first', 'second'], hidden: 'changed without changing the summary' } });
  const changed = await f.inspect();
  assert.notEqual(before.snapshot.inputs['alpha-review'].key, changed.snapshot.inputs['alpha-review'].key);
  assert.notEqual(before.snapshot.artifactHashes.pair, changed.snapshot.artifactHashes.pair);
  assert.equal(before.snapshot.inputs['beta-review'].key, changed.snapshot.inputs['beta-review'].key);
  assert.equal(before.snapshot.inputs['alpha-review'].criticHash, changed.snapshot.inputs['alpha-review'].criticHash);
  await f.saveData('alpha', { summary: 'Scenario A', details: { evidence: ['second', 'first'], hidden: 'accepted' } });
  assert.notEqual(before.snapshot.artifactHashes.alpha, (await f.inspect()).snapshot.artifactHashes.alpha);

  async function saveReordered() {
    await writeFile(join(f.repoPath, 'alpha.json'), '{"details":{"hidden":"accepted","evidence":["first","second"]},"summary":"Scenario A"}');
  }
});

test('actual Human evidence survives A to B to A and a later RED supersedes earlier GREEN on the same input', async t => {
  const f = await fixture(t), broker = f.open();
  const first = await humanReview(broker, 'alpha', 'GREEN');
  await humanReview(broker, 'beta', 'GREEN');
  await f.saveData('alpha', { summary: 'Scenario B', details: { hidden: 'different' } });
  const changed = await f.inspect();
  assert.equal(changed.plan.critics.find(item => item.id === 'alpha-review')?.status, 'STALE');
  assert.equal(changed.plan.critics.find(item => item.id === 'beta-review')?.status, 'PASS');
  await humanReview(broker, 'alpha', 'GREEN');
  await f.saveData('alpha', f.original);
  const restored = await f.inspect();
  assert.equal(restored.plan.satisfied, true);
  assert.equal(restored.plan.critics.find(item => item.id === 'alpha-review')?.result?.runId, first.id);
  const reused = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'alpha' } });
  assert.equal(reused.status, 'GREEN');
  assert.equal(reused.requests.length, 0);
  const rejected = await humanReview(broker, 'alpha', 'RED', true);
  const latest = await f.inspect();
  assert.equal(latest.plan.critics.find(item => item.id === 'alpha-review')?.status, 'RED');
  assert.equal(latest.plan.critics.find(item => item.id === 'alpha-review')?.result?.runId, rejected.id);
  assert.equal(latest.plan.critics.find(item => item.id === 'beta-review')?.status, 'PASS');
});

test('stored generated data reopens through a separate local Broker without regeneration, and damaged material fails explicitly', async t => {
  const f = await fixture(t), broker = f.open();
  const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'alpha' } });
  const request = run.requests[0];
  assert.deepEqual(request.artifacts.map(item => item.id), ['alpha']);
  const reference = request.artifacts[0];
  assert.equal(reference.kind, 'generated');
  if (reference.kind !== 'generated') throw new Error('Expected a generated Artifact reference.');
  assert.deepEqual(reference.input?.data, f.original);
  await writeFile(f.forbidPreparation, 'Reopening must never regenerate captured data.');
  await runUntilSettled(broker, run.id);
  await broker.claimHuman(request.id, 'fixture-reviewer');
  assert.deepEqual((await broker.executeHumanTool(request.id, { reviewerId: 'fixture-reviewer', toolName: 'inspect_alpha' })).content[0].data, f.original);
  const reopened = f.open();
  const stored = reopened.getRequest(request.id)!;
  const options = { worktreePath: stored.workspace.path, artifacts: stored.artifacts, artifactTypes: stored.artifactTypes, configManifest: stored.configManifest, criticId: stored.criticId, audience: 'human' as const, runDir: join(f.root, 'direct-tool-output') };
  const registry = await createReviewTools(options);
  try {
    assert.deepEqual(registry.tools.map(tool => tool.name), ['inspect_alpha']);
    assert.deepEqual((await registry.call('inspect_alpha')).content[0].data, f.original);
    await assert.rejects(registry.call('inspect_beta'), /Unknown/);
  } finally { await registry.close(); }
  const corrupt = structuredClone(stored.artifacts);
  if (corrupt[0].kind !== 'generated' || !corrupt[0].input) throw new Error('Missing captured material.');
  corrupt[0].input.data = { summary: 'Tampered stored material' };
  await assert.rejects(createReviewTools({ ...options, artifacts: corrupt }), /integrity|match/);
  const missing = structuredClone(stored.artifacts);
  if (missing[0].kind !== 'generated') throw new Error('Expected a generated Artifact.');
  delete missing[0].input;
  await assert.rejects(createReviewTools({ ...options, artifacts: missing }), /snapshot|material/i);
  await reopened.completeHuman(request.id, { reviewerId: 'fixture-reviewer', result: { verdict: 'GREEN', summary: 'Fixture Human accepted the captured material through a separate client.', evidence: ['inspect_alpha returned the original complete Scenario A.'] } });
  assert.equal(reopened.getRequest(request.id)?.result?.verdict, 'GREEN');
});

test('repeated data tools isolate captured inputs, returned values and new snapshots of the same Artifact', async t => {
  const f = await fixture(t);
  async function open() {
    const { snapshot: { config } } = await f.inspect();
    const scope = resolveArtifactScope(config.artifacts, ['alpha'], config.artifactInputs);
    const tools = await createReviewTools({ worktreePath: f.repoPath, ...scope, artifactTypes: config.artifactTypes,
      configManifest: config.configManifest, criticId: 'alpha-review', audience: 'human', runDir: join(f.root, 'tools') });
    t.after(() => tools.close());
    return { tools, scope };
  }
  const first = await open();
  const artifact = first.scope.artifacts[0];
  if (artifact.kind !== 'generated' || !artifact.input) throw new Error('Expected captured data.');
  artifact.input.data = { summary: 'Caller mutation after registry creation' };
  assert.ok((await first.tools.preflight()).every(check => check.ok));
  const observed = await first.tools.call('inspect_alpha');
  assert.deepEqual(observed.content[0].data, f.original);
  observed.content[0].data = { summary: 'Caller mutation of returned observation' };
  for (const result of await Promise.all([first.tools.call('inspect_alpha'), first.tools.call('inspect_alpha')])) {
    assert.deepEqual(result.content[0].data, f.original);
  }

  const changed = { summary: 'New captured revision', details: { hidden: 'New evidence' } };
  await f.saveData('alpha', changed);
  const next = await open();
  assert.deepEqual((await next.tools.call('inspect_alpha')).content[0].data, changed);
  assert.deepEqual((await first.tools.call('inspect_alpha')).content[0].data, f.original);
});

test('queries reject explicit preparation before calling the source while verification can capture it', async t => {
  const f = await fixture(t, { preparation: 'explicit' });
  await writeFile(f.forbidPreparation, 'The explicit callback must not run in a query.');
  await readWorkspaceConfig(f.repoPath);
  await assert.rejects(f.inspect(), /requires explicit preparation/);
  assert.equal(await stat(f.stateDir).then(() => true, () => false), false);
  await unlink(f.forbidPreparation);
  const broker = f.open();
  const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'alpha' } });
  assert.equal(run.requests.length, 1);
  const material = run.requests[0].artifacts[0];
  assert.equal(material.kind, 'generated');
  if (material.kind !== 'generated') throw new Error('Expected generated input.');
  assert.deepEqual(material.input?.data, f.original);
});

test('identity kinds, namespaces and versions are recorded and invalidate equal material when their contract changes', async t => {
  const f = await fixture(t);
  let previous = await f.inspect();
  for (const changes of [{ version: '2' }, { namespace: 'another-scenario' }, { identityKind: 'immutable-revision' as const }, { identityKind: 'custom' as const }]) {
    await f.writeConfig(changes);
    const current = await f.inspect();
    assert.deepEqual(current.snapshot.config.artifactInputs?.alpha.data, f.original);
    assert.equal(current.snapshot.config.artifactInputs?.alpha.contentHash, previous.snapshot.config.artifactInputs?.alpha.contentHash);
    assert.notEqual(current.snapshot.artifactHashes.alpha, previous.snapshot.artifactHashes.alpha);
    assert.notEqual(current.snapshot.inputs['alpha-review'].key, previous.snapshot.inputs['alpha-review'].key);
    previous = current;
  }
  await f.writeConfig({ identityKind: 'immutable-revision', resultExpression: '{ data }' });
  await assert.rejects(f.inspect(), /requires a source-scoped immutable revision/);
  await f.writeConfig({ identityKind: 'canonical-data', resultExpression: '{ data: { hidden: undefined } }' });
  const { config } = await readWorkspaceConfig(f.repoPath);
  await assert.rejects(prepareArtifactInputs(config, f.repoPath, 'review'), /only JSON values/);
  assert.equal(await stat(f.stateDir).then(() => true, () => false), false);
});

test('always generated Artifacts keep fixed review material but require new evidence in subsequent requests', async t => {
  const f = await fixture(t, { always: true }), broker = f.open();
  const first = await humanReview(broker, 'alpha', 'GREEN');
  const second = await humanReview(broker, 'alpha', 'GREEN');
  assert.notEqual(first.requests[0].id, second.requests[0].id);
  assert.equal(first.requests[0].validationInput?.key, second.requests[0].validationInput?.key);
  assert.equal(first.requests[0].validationInput?.reusable, false);
  assert.equal(queryProject(first.project!.snapshot, projectHistory(f.stateDir), { runId: first.id, attempts: first.requests, selection: { kind: 'artifact', artifactId: 'alpha' } }).satisfied, true);
  const current = await f.inspect();
  assert.equal(current.plan.critics.find(item => item.id === 'alpha-review')?.needsReview, true);
  assert.equal(await readFile(join(f.repoPath, 'alpha.json'), 'utf8'), JSON.stringify(f.original));
});
