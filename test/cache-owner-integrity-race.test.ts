import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { readIdentityCache } from '../src/project/index.js';

const critic = { id: 'review', title: 'Controlled review', profile: { kind: 'runtime', command: 'node', args: ['--version'], timeoutMs: 5000 }, payload: { instruction: 'Controlled executor.' } };

async function fixture(t: TestContext, mode: 'during-check' | 'after-check' | 'failure' | 'timeout') {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ccdd-integrity-race-')));
  const previous = { state: process.env.CCDD_STATE_HOME, config: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(root, 'machine');
  process.env.CCDD_CONFIG_HOME = join(root, 'config');
  await fs.mkdir(process.env.CCDD_CONFIG_HOME);
  await fs.writeFile(join(process.env.CCDD_CONFIG_HOME, 'resources.json'), JSON.stringify({ identityCapacity: 100, defaultProviderCapacity: 4 }));
  const brokers: ReturnType<typeof createBroker<'full'>>[] = [];
  let start!: () => void, releaseReview!: () => void, cleanupEntered!: () => void, releaseCleanup!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const reviewGate = new Promise<void>(resolve => { releaseReview = resolve; });
  const cleaning = new Promise<void>(resolve => { cleanupEntered = resolve; });
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const calls = join(root, 'calls'), checked = join(root, 'checked'), identityGate = join(root, 'identity-gate');
  t.after(async () => {
    releaseReview(); releaseCleanup();
    await fs.writeFile(identityGate, '').catch(() => {});
    await Promise.all(brokers.map(broker => broker.close()));
    for (const [name, value] of [['CCDD_STATE_HOME', previous.state], ['CCDD_CONFIG_HOME', previous.config]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const name of ['owner', 'follower']) {
    const repo = join(root, name);
    await fs.mkdir(repo);
    await fs.writeFile(join(repo, 'ccdd.json'), JSON.stringify({ name,
      stale: { kind: 'identity', ...(mode === 'timeout' ? { timeoutMs: 500 } : {}), script: { command: 'node', args: ['identity.mjs'] } }, critics: [critic] }));
  }
  const ownerPath = join(root, 'owner');
  await fs.writeFile(join(ownerPath, 'input.txt'), 'original-identity');
  await fs.writeFile(join(ownerPath, 'identity.mjs'), `
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const value = readFileSync('input.txt', 'utf8');
appendFileSync(${JSON.stringify(calls)}, 'call\\n');
const completing = readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length > 1;
if (completing) {
  writeFileSync(${JSON.stringify(checked)}, value);
  if (${JSON.stringify(mode)} === 'during-check') while (!existsSync(${JSON.stringify(identityGate)})) await delay(10);
  if (${JSON.stringify(mode)} === 'failure') process.exit(2);
  if (${JSON.stringify(mode)} === 'timeout') await delay(10000);
}
console.log(value);
`);
  await fs.writeFile(join(root, 'follower', 'identity.mjs'), "console.log('original-identity');\n");
  const owner = createBroker({ repoPath: ownerPath, stateDir: join(root, 'owner-state'), repoId: 'owner', detail: 'full',
    admission: { acquire: async () => ({ release: async () => {
      if (mode === 'after-check') { cleanupEntered(); await cleanupGate; }
    } }) },
    executors: { canExecute: () => ({ ok: true }), execute: async () => { start(); await reviewGate; return { verdict: 'GREEN' }; } } });
  const follower = createBroker({ repoPath: join(root, 'follower'), stateDir: join(root, 'follower-state'), repoId: 'follower', detail: 'full',
    executors: { canExecute: () => ({ ok: true }), execute: async () => { throw new Error('The follower must join.'); } } });
  brokers.push(owner, follower);
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) { if (Date.now() > deadline) throw new Error('Barrier timed out.'); await delay(10); }
  };
  const first = await owner.submitProject({ selection: { kind: 'all' } }), runningOwner = owner.run(first.id);
  await started;
  const second = await follower.submitProject({ selection: { kind: 'all' } }), runningFollower = follower.run(second.id);
  await until(() => follower.getRun(second.id)!.requests[0].cacheDisposition === 'coalesced');
  // Exercise the documented independent-owner path: the source has no remaining observer,
  // but another repository still needs the shared computation.
  owner.cancel(first.id); await runningOwner;
  return { ownerPath, calls, checked, identityGate, releaseReview, cleaning, releaseCleanup, follower, second, runningFollower, until };
}

// Documented limit: CCDD does not lock the workspace, so an edit racing the completion
// identity check itself (after the script read the input) is not detected. Callers must
// not edit identity-covered input while an execution of that identity is in flight.
test('a covered edit racing the completion identity check itself is not detected', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'during-check');
  f.releaseReview();
  await f.until(() => fs.access(f.checked).then(() => true, () => false));
  assert.equal(await fs.readFile(f.checked, 'utf8'), 'original-identity');
  await fs.writeFile(join(f.ownerPath, 'input.txt'), 'changed-identity');
  await fs.writeFile(f.identityGate, 'continue');
  await f.runningFollower;
  assert.equal(await fs.readFile(join(f.ownerPath, 'input.txt'), 'utf8'), 'changed-identity');
  assert.equal(readIdentityCache('original-identity')!.value.result.verdict, 'GREEN', 'the check saw the value read before the edit');
  assert.equal(f.follower.getRun(f.second.id)!.requests[0].status, 'GREEN');
});

test('a covered edit between the final identity check and cache publication must be rejected', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'after-check');
  f.releaseReview();
  await f.cleaning;
  assert.equal((await fs.readFile(f.calls, 'utf8')).trim().split('\n').length, 1, 'the completion identity check runs only after resource cleanup');
  assert.equal(readIdentityCache('original-identity'), null, 'nothing is published before the completion check');
  await fs.writeFile(join(f.ownerPath, 'input.txt'), 'changed-identity');
  f.releaseCleanup();
  await f.runningFollower;
  assert.equal(readIdentityCache('original-identity'), null, 'must not publish after an edit before cache commit');
  assert.equal(f.follower.getRun(f.second.id)!.requests[0].errorCode, 'WORKSPACE_CHANGED');
});

for (const mode of ['failure', 'timeout'] as const) test(`completion identity ${mode} rejects and never publishes`, { timeout: 15000 }, async t => {
  const f = await fixture(t, mode);
  f.releaseReview(); await f.runningFollower;
  assert.equal(f.follower.getRun(f.second.id)!.requests[0].status, 'ERROR');
  assert.equal(f.follower.getRun(f.second.id)!.requests[0].errorCode, 'COMPUTE_FAILED');
  assert.equal(readIdentityCache('original-identity'), null);
});
