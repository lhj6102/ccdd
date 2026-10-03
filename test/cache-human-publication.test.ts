import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { openResources } from '../src/resources.js';
import { readIdentityCache } from '../src/cache/index.js';

// Hold identity capacity only after Human's submission boundary has passed. This
// distinguishes owner verdict acceptance from the later cache publication check.
test('Human publication rechecks identity after the owner verdict and store close', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccdd-human-publication-'));
  const previous = { state: process.env.CCDD_STATE_HOME, config: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(root, 'machine'); process.env.CCDD_CONFIG_HOME = join(root, 'config');
  await fs.mkdir(process.env.CCDD_CONFIG_HOME);
  await fs.writeFile(join(process.env.CCDD_CONFIG_HOME, 'resources.json'), JSON.stringify({ identityCapacity: 100, defaultProviderCapacity: 4 }));
  const brokers: ReturnType<typeof createBroker<'full'>>[] = [], resources = openResources();
  let blocker: Awaited<ReturnType<typeof resources.acquire>> | undefined;
  t.after(async () => {
    await blocker?.release(); await Promise.all(brokers.map(b => b.close())); resources.close();
    for (const [key, value] of [['CCDD_STATE_HOME', previous.state], ['CCDD_CONFIG_HOME', previous.config]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls = join(root, 'calls'), submittedIdentity = join(root, 'submitted-identity'), continueIdentity = join(root, 'continue-identity');
  for (const name of ['owner', 'follower']) {
    await fs.mkdir(join(root, name));
    await fs.writeFile(join(root, name, 'ccdd.json'), JSON.stringify({ name,
      stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } },
      views: { humanTools: { read: { metadata: { description: 'Read fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text'], observation: 'content' }, script: { command: 'node', args: ['read.mjs'] } } } },
      critics: [{ id: 'review', title: 'Human', profile: { kind: 'human' }, payload: { instruction: 'Controlled Human review' } }] }));
    await fs.writeFile(join(root, name, 'read.mjs'), "console.log(JSON.stringify({content:[{type:'text',text:'Fixture'}],observation:{kind:'content'}}));\n");
  }
  const ownerPath = join(root, 'owner');
  await fs.writeFile(join(ownerPath, 'input.txt'), 'human-publication');
  await fs.writeFile(join(ownerPath, 'identity.mjs'), `
import{readFileSync,appendFileSync,writeFileSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';
const value=readFileSync('input.txt','utf8');appendFileSync(${JSON.stringify(calls)},'call\\n');
if(readFileSync(${JSON.stringify(calls)},'utf8').trim().split('\\n').length===3){writeFileSync(${JSON.stringify(submittedIdentity)},value);while(!existsSync(${JSON.stringify(continueIdentity)}))await delay(10);}
console.log(value);`);
  await fs.writeFile(join(root, 'follower', 'identity.mjs'), "console.log('human-publication');\n");
  const make = (name: string) => {
    const broker = createBroker({ repoPath: join(root, name), stateDir: join(root, `${name}-state`), repoId: name, detail: 'full',
      executors: { canExecute: () => ({ ok: true }), notifyHuman: async () => {}, execute: async () => { throw new Error('Human only'); } } });
    brokers.push(broker); return broker;
  };
  const owner = make('owner'), follower = make('follower');
  const until = async (p: () => boolean | Promise<boolean>) => { const end = Date.now() + 10000; while (!await p()) { if (Date.now() > end) throw new Error('Barrier timed out'); await delay(10); } };
  const first = await owner.submitProject({ selection: { kind: 'all' } }), one = owner.run(first.id);
  await until(() => owner.getRun(first.id)!.requests[0].notifiedAt != null);
  const second = await follower.submitProject({ selection: { kind: 'all' } }), two = follower.run(second.id);
  await until(() => follower.getRun(second.id)!.requests[0].notifiedAt != null);
  owner.cancel(first.id); await one;
  const id = follower.getRun(second.id)!.requests[0].id;
  await follower.claimHuman(id, 'reviewer');
  const complete = follower.completeHuman(id, { reviewerId: 'reviewer', result: { verdict: 'GREEN' } });
  await until(() => fs.access(submittedIdentity).then(() => true, () => false));
  // FIFO puts this weight-100 blocker behind the active submission identity and
  // ahead of the not-yet-started publication identity check.
  const acquire = resources.acquire({ requestId: 'block-publication', runId: '', kind: 'identity', repo: 'controlled', identityWeight: 100 }, { signal: new AbortController().signal, waiting() {} });
  await fs.writeFile(continueIdentity, 'continue'); blocker = await acquire;
  await fs.writeFile(join(ownerPath, 'input.txt'), 'changed-human-publication');
  await blocker.release(); blocker = undefined;
  await complete; await two;
  assert.equal((await fs.readFile(calls, 'utf8')).trim().split('\n').length, 4, 'initial, claim, submission, and publication each validate identity');
  assert.equal(follower.getRun(second.id)!.requests[0].errorCode, 'WORKSPACE_CHANGED');
  assert.equal(readIdentityCache('human-publication'), null);
});
