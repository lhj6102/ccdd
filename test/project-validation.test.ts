import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import { inspectProject, projectHistory, projectRun, projectRequests, queryProject } from '../src/project/index.js';
import { main } from '../src/project/cli.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createMonitorStore } from '../src/monitor/store.js';
import type { RepoConfig, CriticDefinition } from '../src/contracts.js';

async function fixture(t: TestContext, configure?: (config: RepoConfig) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccdd-project-test-'));
  const repoPath = path.join(root, 'repo'), stateDir = path.join(root, 'state');
  const critic = (id: string, target: string, deps: string[]): CriticDefinition => ({ id, title: id, target, deps,
    profile: { kind: 'runtime', command: 'node', args: ['--test', `${target}/${id}.test.mjs`] }, payload: { instruction: 'Run the actual project test.' } });
  const config: RepoConfig = { artifacts: { a: { type: 'code', path: 'a' }, b: { type: 'code', path: 'b' }, c: { type: 'code', path: 'c' } },
    artifactTypes: { code: { viewer: 'files', agentTools: { list: {}, read: {} }, humanTools: { list: {}, read: {} } } },
    critics: [critic('a-check', 'a', []), critic('b-a', 'b', ['a']), critic('b-own', 'b', []), critic('c-b', 'c', ['b'])] };
  for (const id of ['a', 'b', 'c']) { await fs.mkdir(path.join(repoPath, id), { recursive: true }); await fs.writeFile(path.join(repoPath, id, 'input.txt'), 'accepted input'); }
  for (const c of config.critics) await fs.writeFile(path.join(repoPath, c.target, `${c.id}.test.mjs`), `import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('accepted input', () => assert.match(readFileSync(${JSON.stringify(c.target + '/input.txt')}, 'utf8'), /^accepted/));`);
  configure?.(config);
  const saveConfig = () => fs.writeFile(path.join(repoPath, 'ccdd.config.json'), JSON.stringify(config));
  await saveConfig();
  const brokers: ReturnType<typeof createBroker>[] = [];
  const open = () => { const broker = createBroker({ repoPath, stateDir, repoId: 'local', executors: createExecutorRegistry({ alarmMethods: [async () => {}] }) }); brokers.push(broker); return broker; };
  t.after(async () => { for (const broker of brokers) await broker.close(); await removeOwnedWorkspaceTree(root); });
  return { root, repoPath, stateDir, config, saveConfig, open, inspect: (selection?: Parameters<typeof inspectProject>[0]['selection']) => inspectProject({ repoPath, stateDir, selection }) };
}

test('pull queries do not create a database, tickets, or persistent stale states', async t => {
  const f = await fixture(t);
  const q = await f.inspect({ kind: 'artifact', artifactId: 'b' });
  assert.equal(q.plan.satisfied, false);
  assert.equal(q.plan.items.find(c => c.id === 'b-own')?.action, 'EXECUTE');
  assert.equal(q.plan.items.find(c => c.id === 'b-a')?.action, 'WAIT');
  assert.equal(await fs.stat(f.stateDir).then(() => true, () => false), false);
});

test('individual validation executes the independent Critic and reports the rest incomplete', async t => {
  const f = await fixture(t), broker = f.open();
  const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'b' } });
  assert.deepEqual(run.requests.map(r => r.criticId), ['b-own']);
  await broker.run(run.id);
  const result = projectRun(f.stateDir, run.id)!;
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.validation?.satisfied, false);
  assert.equal(result.requests[0].result?.verdict, 'GREEN');
  assert.equal(projectHistory(f.stateDir).length, 1);
  const a = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'a' } });
  await broker.run(a.id);
  assert.equal(projectRun(f.stateDir, run.id)?.status, 'INCOMPLETE');
  assert.equal(projectRun(f.stateDir, run.id)?.validation?.satisfied, false, 'completed history must not borrow a later result');
});

test('recursive validation runs real tests; unchanged intermediates stop downstream re-execution', async t => {
  const f = await fixture(t), broker = f.open();
  const first = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'c' }, recursive: true });
  assert.deepEqual(first.requests.map(r => r.criticId), ['a-check', 'b-own']);
  await broker.run(first.id);
  const completed = projectRun(f.stateDir, first.id)!;
  assert.equal(completed.status, 'GREEN', JSON.stringify(completed));
  assert.equal(completed.requests.length, 4);
  assert.ok(completed.requests.every(r => r.result?.verdict === 'GREEN' && r.validationInput));
  await fs.writeFile(path.join(f.repoPath, 'a/input.txt'), 'accepted additional reference');
  assert.equal((await f.inspect({ kind: 'artifact', artifactId: 'c' })).plan.satisfied, false);
  const second = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'c' }, recursive: true });
  await broker.run(second.id);
  const after = projectRun(f.stateDir, second.id)!;
  assert.equal(after.status, 'GREEN', JSON.stringify(after));
  assert.deepEqual(after.requests.map(r => r.criticId), ['a-check', 'b-a']);
  assert.equal(after.validation?.critics.find(c => c.id === 'c-b')?.result?.runId, first.id);
  assert.equal((await f.inspect({ kind: 'artifact', artifactId: 'c' })).plan.satisfied, true);
  const third = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'c' }, recursive: true });
  assert.equal(third.status, 'GREEN'); assert.equal(third.requests.length, 0);
  const db = new DatabaseSync(path.join(f.stateDir, 'broker.sqlite'), { readOnly: true });
  try {
    const data = db.prepare('SELECT data FROM runs UNION ALL SELECT data FROM requests').all().map(r => String(r.data)).join('\n');
    assert.doesNotMatch(data, /staleState|"isStale"/);
  } finally { db.close(); }
});

test('a dependency that changed and already passed still changes its direct consumer input', async t => {
  const f = await fixture(t), broker = f.open();
  const one = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(one.id);
  await fs.writeFile(path.join(f.repoPath, 'a/input.txt'), 'accepted new input');
  const a = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'a' } }); await broker.run(a.id);
  const q = await f.inspect({ kind: 'artifact', artifactId: 'b' });
  assert.equal(q.plan.critics.find(c => c.id === 'b-a')?.status, 'STALE');
  assert.equal(q.plan.critics.find(c => c.id === 'b-own')?.status, 'PASS');
  assert.equal(q.plan.critics.find(c => c.id === 'c-b')?.status, 'BLOCKED');
});

test('force reviews only the selected Critic; a later actual RED is not hidden by an old PASS', async t => {
  const f = await fixture(t), broker = f.open();
  const one = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(one.id);
  const forced = await broker.submitProject({ selection: { kind: 'critic', criticId: 'b-own' }, force: true, recursive: true });
  await broker.run(forced.id);
  assert.deepEqual(projectRun(f.stateDir, forced.id)?.requests.map(r => r.criticId), ['b-own']);
  // Exercise the real durable Human path for conflicting judgments on identical input.
  f.config.critics[2].profile = { kind: 'human' }; await f.saveConfig();
  for (const verdict of ['GREEN', 'RED'] as const) {
    const run = await broker.submitProject({ selection: { kind: 'critic', criticId: 'b-own' }, force: true });
    await broker.run(run.id); const id = broker.getRun(run.id)!.requests[0].id;
    broker.claimHuman(id, 'reviewer');
    await broker.completeHuman(id, { reviewerId: 'reviewer', result: { verdict, summary: `Human submitted ${verdict}`, evidence: ['Explicit test reviewer submission.'] } });
  }
  const q = await f.inspect({ kind: 'critic', criticId: 'b-own' });
  assert.equal(q.plan.satisfied, false); assert.equal(q.plan.critics.find(c => c.id === 'b-own')?.status, 'RED');
});

test('always is scoped to one validation request and never loops inside a recursive execution', async t => {
  const f = await fixture(t, config => { config.artifacts.a.stale = { kind: 'always' }; }), broker = f.open();
  const runs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const run = await broker.submitProject({ selection: { kind: 'artifact', artifactId: 'c' }, recursive: true });
    await broker.run(run.id);
    const result = projectRun(f.stateDir, run.id)!;
    runs.push(run.id);
    assert.equal(result.status, 'GREEN');
    assert.equal(result.requests.filter(r => r.criticId === 'a-check').length, 1);
    assert.equal(result.requests.filter(r => r.criticId === 'b-a').length, 1);
  }
  const first = projectRun(f.stateDir, runs[0])!;
  assert.equal(queryProject(first.project!.snapshot, projectHistory(f.stateDir), { runId: first.id, attempts: first.requests, selection: { kind: 'artifact', artifactId: 'c' } }).satisfied, true, 'another request must not hide the evidence from this always request');
});

test('project CLI executes detached workers, exposes incomplete work and reuses actual evidence', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const call = async (args: string[]) => {
    let output = ''; const code = await main([...args, '--repo', f.repoPath, '--state-dir', f.stateDir, '--json'], { stdout: { write: text => { output += text; } } });
    return { code, value: JSON.parse(output) };
  };
  const plan = await call(['plan', 'b']); assert.equal(plan.code, 0); assert.equal(plan.value.counts.execute, 1); assert.equal(plan.value.counts.wait, 1);
  assert.equal(await fs.stat(f.stateDir).then(() => true, () => false), false);
  assert.equal((await call(['verify', 'b', '--critic', 'b-own'])).code, 2);
  assert.equal(await fs.stat(f.stateDir).then(() => true, () => false), false);
  assert.deepEqual(Object.keys((await call(['graph', 'b'])).value.artifacts), ['a', 'b']);
  const individual = await call(['verify', 'b', '--wait', '--timeout-ms', '90000']);
  assert.equal(individual.code, 4, JSON.stringify(individual)); assert.equal(individual.value.requests.length, 1);
  const complete = await call(['verify', 'c', '--recursive', '--wait', '--timeout-ms', '90000']);
  assert.equal(complete.code, 0, JSON.stringify(complete)); assert.equal(complete.value.status, 'GREEN');
  const reuse = await call(['verify', 'c', '--recursive', '--wait']); assert.equal(reuse.code, 0); assert.equal(reuse.value.requests.length, 0);
  assert.equal((await call(['status', 'c'])).code, 0);
  assert.equal((await call(['history', 'b'])).value.length, 2);
  const monitor = createMonitorStore({ stateDirs: [f.stateDir], stateHome: path.join(f.root, 'empty') });
  const overview = await monitor.runs();
  const graph = await monitor.graph(overview.projects[0].id, reuse.value.id);
  assert.equal(graph?.available, true, JSON.stringify(graph)); assert.equal(graph.requests.length, 0);
  const reused = graph.graph!.critics.find(c => c.id === 'c-b')!;
  assert.equal(reused.validationStatus, 'PASS'); assert.equal(reused.reusedFrom?.runId, complete.value.id);
  assert.ok(await monitor.detail(overview.projects[0].id, reused.requestId!));
});

test('project Human claim, scoped tool and submission continue the original recursive request', { timeout: 120_000 }, async t => {
  const f = await fixture(t, config => { config.critics[2].profile = { kind: 'human' }; });
  const call = async (args: string[]) => {
    let output = ''; const code = await main([...args, '--repo', f.repoPath, '--state-dir', f.stateDir, '--json'], { stdout: { write: text => { output += text; } } });
    return { code, value: JSON.parse(output) };
  };
  const started = await call(['verify', 'c', '--recursive', '--human-inbox']); assert.equal(started.code, 0, JSON.stringify(started));
  const deadline = Date.now() + 60000;
  let request;
  while (Date.now() < deadline) {
    request = projectRequests(f.stateDir, started.value.id).find(r => r.criticId === 'b-own');
    if (request?.notifiedAt) break;
    await delay(100);
  }
  assert.equal(request?.status, 'WAITING_HUMAN'); assert.ok(request.notifiedAt);
  assert.equal((await call(['request', 'claim', request.id, '--reviewer', 'fixture-reviewer'])).code, 0);
  const tool = await call(['request', 'tool', request.id, '--reviewer', 'fixture-reviewer', '--tool', 'read_b', '--args', JSON.stringify({ path: 'input.txt' })]);
  assert.equal(tool.code, 0, JSON.stringify(tool)); assert.match(JSON.stringify(tool.value), /accepted input/);
  const resultFile = path.join(f.root, 'human-result.json');
  await fs.writeFile(resultFile, JSON.stringify({ verdict: 'GREEN', summary: 'Fixture Human accepted the observed input.', evidence: ['read_b returned accepted input.'] }));
  assert.equal((await call(['request', 'submit', request.id, '--reviewer', 'fixture-reviewer', '--result-file', resultFile])).code, 0);
  const completed = await call(['run', 'show', started.value.id, '--wait', '--timeout-ms', '90000']);
  assert.equal(completed.code, 0, JSON.stringify(completed)); assert.equal(completed.value.requests.length, 4);
});

test('declared hash paths detect added and removed files without unrelated invalidation', async t => {
  const f = await fixture(t, config => { config.artifacts.a.stale = { kind: 'file-hash', paths: ['a', 'references'] }; });
  const before = await f.inspect();
  await fs.writeFile(path.join(f.repoPath, 'unrelated.txt'), 'other work');
  const unrelated = await f.inspect();
  assert.equal(before.snapshot.inputs['a-check'].key, unrelated.snapshot.inputs['a-check'].key);
  await fs.mkdir(path.join(f.repoPath, 'references')); await fs.writeFile(path.join(f.repoPath, 'references/new.txt'), 'extra reference');
  const added = await f.inspect();
  assert.notEqual(before.snapshot.inputs['a-check'].key, added.snapshot.inputs['a-check'].key);
  assert.notEqual(before.snapshot.inputs['b-a'].key, added.snapshot.inputs['b-a'].key);
  assert.equal(before.snapshot.inputs['c-b'].key, added.snapshot.inputs['c-b'].key);
  await fs.unlink(path.join(f.repoPath, 'references/new.txt'));
  assert.notEqual(added.snapshot.inputs['a-check'].key, (await f.inspect()).snapshot.inputs['a-check'].key);
});

test('groups track member content but do not inherit member validation gates', async t => {
  const f = await fixture(t, config => {
    config.artifacts.group = { kind: 'group', members: ['a', 'b'] };
    config.critics.push({ id: 'group-check', title: 'group-check', target: 'group', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Review both members together.' } });
  });
  const before = await f.inspect({ kind: 'artifact', artifactId: 'group' });
  assert.equal(before.plan.items[0].canExecute, true); assert.equal(before.plan.artifacts.find(a => a.id === 'a')?.isStale, true);
  await fs.writeFile(path.join(f.repoPath, 'a/input.txt'), 'accepted new reference');
  const after = await f.inspect();
  assert.notEqual(before.snapshot.artifactHashes.group, after.snapshot.artifactHashes.group);
  assert.equal(before.snapshot.inputs['c-b'].key, after.snapshot.inputs['c-b'].key);
});

test('an actual RED blocks only consumers and preserves independent successful reviews', async t => {
  const f = await fixture(t), broker = f.open();
  await fs.writeFile(path.join(f.repoPath, 'a/input.txt'), 'rejected input');
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  const completed = projectRun(f.stateDir, run.id)!;
  assert.equal(completed.status, 'RED');
  assert.deepEqual(completed.requests.map(r => [r.criticId, r.status]), [['a-check', 'RED'], ['b-own', 'GREEN']]);
  assert.equal(completed.validation?.critics.find(c => c.id === 'b-a')?.status, 'BLOCKED');
  assert.equal(completed.validation?.critics.find(c => c.id === 'c-b')?.status, 'BLOCKED');
});

test('changing an imported tool implementation invalidates evidence even when Artifact content is equal', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.repoPath, 'ccdd.config.json'));
  const definition = { artifacts: { a: f.config.artifacts.a }, critics: [f.config.critics[0]] };
  const helper = (text: string) => `export const tool = { metadata: { description: 'Inspect content', inputSchema: { type: 'object', properties: {} }, resultKinds: ['text'], observation: 'none' }, execute() { return { content: [{ type: 'text', text: '${text}' }] }; } };`;
  await fs.writeFile(path.join(f.repoPath, 'helper.ts'), helper('first implementation'));
  await fs.writeFile(path.join(f.repoPath, 'ccdd.config.ts'), `import { tool } from './helper.ts'; export default { ...${JSON.stringify(definition)}, artifactTypes: { code: { agentTools: { inspect: tool } } } };`);
  const before = await f.inspect();
  await fs.writeFile(path.join(f.repoPath, 'helper.ts'), helper('second implementation'));
  const after = await f.inspect();
  assert.equal(before.snapshot.artifactHashes.a, after.snapshot.artifactHashes.a);
  assert.notEqual(before.snapshot.inputs['a-check'].criticHash, after.snapshot.inputs['a-check'].criticHash);
});
