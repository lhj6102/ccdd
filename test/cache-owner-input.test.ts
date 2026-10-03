import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, type BrokerExecutors } from '../src/broker/index.js';
import { readIdentityCache } from '../src/project/index.js';

const critic = { id: 'review', title: 'Controlled review', profile: { kind: 'runtime', command: 'node', args: ['--version'], timeoutMs: 5000 }, payload: { instruction: 'Controlled executor.' } };

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ccdd-owner-input-')));
  const previous = { state: process.env.CCDD_STATE_HOME, config: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(root, 'machine'); process.env.CCDD_CONFIG_HOME = join(root, 'config');
  await fs.mkdir(process.env.CCDD_CONFIG_HOME);
  await fs.writeFile(join(process.env.CCDD_CONFIG_HOME, 'resources.json'), JSON.stringify({ identityCapacity: 100, defaultProviderCapacity: 8 }));
  const brokers: ReturnType<typeof createBroker<'full'>>[] = [];
  t.after(async () => {
    await Promise.all(brokers.map(broker => broker.close()));
    for (const [name, value] of [['CCDD_STATE_HOME', previous.state], ['CCDD_CONFIG_HOME', previous.config]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const broker = (name: string, executors: BrokerExecutors) => {
    const created = createBroker({ repoPath: join(root, name), stateDir: join(root, `${name}-state`), repoId: name, detail: 'full', executors });
    brokers.push(created); return created;
  };
  const until = async (predicate: () => boolean) => { const end = Date.now() + 20_000; while (!predicate()) { if (Date.now() > end) throw new Error('Test barrier timed out.'); await delay(10); } };
  return { root, broker, until };
}

test('cache-owned executions neither observe nor walk the workspace per owner; each re-runs only its owner identity', async t => {
  // Enough owners that one walk each would exceed the bound; scale itself is covered by test:scale.
  const f = await fixture(t), owners = 24, repoPath = join(f.root, 'catalog'), calls = join(f.root, 'identity-calls');
  await fs.mkdir(join(repoPath, 'family'), { recursive: true });
  for (let i = 0; i < 200; i++) await fs.writeFile(join(repoPath, `material-${i}.txt`), `workspace material ${i}\n`);
  await fs.writeFile(join(repoPath, 'family', 'ccdd.json'), JSON.stringify({ name: 'catalog', family: { instances: Object.fromEntries(Array.from({ length: owners }, (_, i) => [`item-${i}`, {}])) },
    stale: { kind: 'identity', weight: 1, script: { command: 'node', args: ['identity.mjs'] } }, critics: [critic] }));
  // Calls are recorded outside the reviewed workspace.
  await fs.writeFile(join(repoPath, 'family', 'identity.mjs'), `import{appendFileSync}from'node:fs';let text='';for await(const chunk of process.stdin)text+=chunk;appendFileSync(${JSON.stringify(calls)},'call\\n');console.log('owner-input-'+JSON.parse(text).artifactId);\n`);
  let starts = 0;
  const broker = f.broker('catalog', { canExecute: () => ({ ok: true }), execute: async () => { starts++; return { verdict: 'GREEN' }; } });
  const submitted = await broker.submitProject({ selection: { kind: 'all' } });
  assert.equal(submitted.requests.length, owners);
  const identityCalls = async () => (await fs.readFile(calls, 'utf8')).split('\n').filter(Boolean).length;
  assert.equal(await identityCalls(), owners, 'preparation computes every identity once');

  // Count at the filesystem seam: recursive watchers and traversals of the workspace root.
  let observers = 0, walks = 0;
  const watch = nativeFs.watch, readdir = fs.readdir;
  t.mock.method(nativeFs, 'watch', (...args: unknown[]) => { if (args[0] === repoPath && (args[1] as { recursive?: boolean } | undefined)?.recursive) observers++; return Reflect.apply(watch, nativeFs, args); });
  t.mock.method(fs, 'readdir', (...args: unknown[]) => { if (args[0] === repoPath) walks++; return Reflect.apply(readdir, fs, args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const started = performance.now();
  await broker.run(submitted.id);
  const elapsedSeconds = (performance.now() - started) / 1000;
  t.mock.restoreAll(); syncBuiltinESMExports();

  const run = broker.getRun(submitted.id)!;
  assert.equal(run.status, 'GREEN');
  assert.equal(starts, owners);
  assert.ok(run.requests.every(request => request.cacheDisposition === 'executed'));
  assert.equal(observers, 1, 'only the submitting Run observes its workspace');
  // That observer acquires once (metadata, then content) and adds at most one metadata
  // fallback per elapsed second. A per-owner walk would add at least one per owner.
  assert.ok(walks <= 2 + Math.ceil(elapsedSeconds) + 1, `${walks} workspace walks in ${elapsedSeconds.toFixed(1)} s`);
  assert.equal(await identityCalls(), 2 * owners, 'each owner re-runs its identity once, at completion');
});

async function sharedOwner(t: TestContext, human = false) {
  const f = await fixture(t);
  for (const name of ['owner', 'follower']) {
    await fs.mkdir(join(f.root, name));
    await fs.writeFile(join(f.root, name, 'ccdd.json'), JSON.stringify({ name, stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } },
      ...(human ? { views: { humanTools: { read: { metadata: { description: 'Read the controlled fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text'], observation: 'content' }, script: { command: 'node', args: ['read.mjs'] } } } } } : {}),
      critics: [human ? { ...critic, profile: { kind: 'human' } } : critic] }));
    await fs.writeFile(join(f.root, name, 'read.mjs'), "console.log(JSON.stringify({content:[{type:'text',text:'Controlled Human fixture'}],observation:{kind:'content'}}));\n");
  }
  // Same explicit identity in two repositories; the owner's value comes from its own input file.
  await fs.writeFile(join(f.root, 'owner', 'identity-input.txt'), 'shared-owner-value');
  await fs.writeFile(join(f.root, 'owner', 'identity.mjs'), "import{readFileSync}from'node:fs';console.log(readFileSync('identity-input.txt','utf8'));\n");
  await fs.writeFile(join(f.root, 'follower', 'identity.mjs'), "console.log('shared-owner-value');\n");
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const owner = f.broker('owner', { canExecute: () => ({ ok: true }), execute: async () => { started = true; await gate; return { verdict: 'GREEN' }; }, notifyHuman: async () => { started = true; } });
  const follower = f.broker('follower', { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('The follower must join the shared execution.'); }, notifyHuman: async () => {} });
  const first = await owner.submitProject({ selection: { kind: 'all' } }), runningOwner = owner.run(first.id);
  await f.until(() => started && (!human || owner.getRun(first.id)!.requests[0].notifiedAt != null));
  const second = await follower.submitProject({ selection: { kind: 'all' } }), runningFollower = follower.run(second.id);
  await f.until(() => follower.getRun(second.id)!.requests[0].cacheDisposition === 'coalesced' && (!human || follower.getRun(second.id)!.requests[0].notifiedAt != null));
  // Only the follower now subscribes; the owner's workspace has no observing Run.
  owner.cancel(first.id); await runningOwner;
  return { ...f, release, follower, second, runningFollower, ownerPath: join(f.root, 'owner') };
}

test('a cache-owned execution is not invalidated by workspace changes outside its owner identity', async t => {
  const f = await sharedOwner(t);
  await fs.writeFile(join(f.ownerPath, 'unrelated.txt'), 'Written while the shared execution runs.');
  f.release(); await f.runningFollower;
  const request = f.follower.getRun(f.second.id)!.requests[0];
  assert.equal(request.status, 'GREEN');
  assert.equal(request.cacheDisposition, 'coalesced');
  assert.equal(readIdentityCache('shared-owner-value')!.value.result.verdict, 'GREEN');
});

test('a changed owner identity fails the shared execution as WORKSPACE_CHANGED and publishes nothing', async t => {
  const f = await sharedOwner(t);
  await fs.writeFile(join(f.ownerPath, 'identity-input.txt'), 'another-owner-value');
  f.release(); await f.runningFollower;
  const request = f.follower.getRun(f.second.id)!.requests[0];
  assert.equal(request.status, 'ERROR');
  assert.equal(request.errorCode, 'WORKSPACE_CHANGED');
  assert.equal(readIdentityCache('shared-owner-value'), null);
});

test('a cache-owned Human review ignores changes outside its identity and rejects a result after its identity changes', async t => {
  const f = await sharedOwner(t, true), id = f.follower.getRun(f.second.id)!.requests[0].id;
  await fs.writeFile(join(f.ownerPath, 'unrelated.txt'), 'Written during Human waiting.');
  await delay(300);
  assert.equal(f.follower.getRun(f.second.id)!.requests[0].status, 'WAITING_HUMAN');
  await f.follower.claimHuman(id, 'reviewer');
  await fs.writeFile(join(f.ownerPath, 'identity-input.txt'), 'another-owner-value');
  await assert.rejects(f.follower.completeHuman(id, { reviewerId: 'reviewer', result: { verdict: 'GREEN' } }), { code: 'WORKSPACE_CHANGED' });
  await f.runningFollower;
  assert.equal(f.follower.getRun(f.second.id)!.requests[0].errorCode, 'WORKSPACE_CHANGED');
  assert.equal(readIdentityCache('shared-owner-value'), null);
});
