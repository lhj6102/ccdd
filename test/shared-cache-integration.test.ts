import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { inspectProject, readIdentityCache } from '../src/project/index.js';
import { projectRun } from '../src/project/store.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-shared-integration-'));
  const previous = process.env.CCDD_STATE_HOME; process.env.CCDD_STATE_HOME = join(root, 'home');
  const brokers: ReturnType<typeof createBroker<'full'>>[] = [];
  t.after(async () => { await Promise.all(brokers.map(broker => broker.close())); if (previous === undefined) delete process.env.CCDD_STATE_HOME; else process.env.CCDD_STATE_HOME = previous; await rm(root,{recursive:true,force:true}); });
  const count = join(root,'count');
  async function repo(name: string, identity: string | null = 'shared-value', hold = false) {
    const repoPath = join(root,name), stateDir = join(root,`${name}-state`); await mkdir(repoPath);
    await writeFile(join(repoPath,'ccdd.json'), JSON.stringify({ name, ...(identity ? { stale: { kind:'identity',script:{command:'node',args:['identity.mjs']} } } : {}),
      critics:[{id:'review',title:`Actual ${name} review`,profile:{kind:'runtime',command:'node',args:['--test','check.test.mjs'],timeoutMs:15000},payload:{instruction:'Run the actual test.'}}] }));
    await writeFile(join(repoPath,'identity.mjs'),`console.log(${JSON.stringify(identity)});`);
    await writeFile(join(repoPath,'check.test.mjs'),`import test from 'node:test';import {appendFile,access} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';test('actual execution',async()=>{await appendFile(${JSON.stringify(count)},'${name}\\n');${hold ? `while(!await access(${JSON.stringify(join(root,'release'))}).then(()=>true,()=>false))await delay(10);` : ''}});`);
    const broker = createBroker({ repoPath,stateDir,repoId:name,detail:'full',executors:createExecutorRegistry({alarmMethods:[{id:'test-inbox',notify(){}}]}) }); brokers.push(broker);
    return {repoPath,stateDir,broker};
  }
  const until = async (predicate:()=>boolean|Promise<boolean>) => { const end=Date.now()+10000;while(!await predicate()){if(Date.now()>end)throw Error('Test barrier timed out.');await delay(20);} };
  return {root,count,repo,until};
}

test('production Broker and plan reuse across repositories and Critic IDs after the source is removed', async t => {
  const f=await fixture(t), a=await f.repo('alpha'), b=await f.repo('beta');
  const first=await a.broker.submitProject({selection:{kind:'all'}}); await a.broker.run(first.id);
  assert.equal(a.broker.getRun(first.id)!.status,'GREEN');
  assert.equal((await readFile(f.count,'utf8')).trim(),'alpha');
  const cached=readIdentityCache('shared-value'); assert.ok(cached); assert.ok(cached.value.origin.stateDir);
  await a.broker.close(); await rm(a.repoPath,{recursive:true}); await rm(a.stateDir,{recursive:true});
  const plan=await inspectProject({repoPath:b.repoPath,stateDir:b.stateDir,selection:{kind:'all'}});
  assert.equal(plan.plan.counts.reuse,1);
  const second=await b.broker.submitProject({selection:{kind:'all'},maxExecutions:0}); await b.broker.run(second.id);
  const result=b.broker.getRun(second.id)!;
  assert.equal(result.status,'GREEN'); assert.equal(result.requests[0].cacheDisposition,'hit');
  assert.equal(result.requests[0].executionSource?.executionId,cached.executionId);
  assert.equal((await readFile(f.count,'utf8')).trim(),'alpha');
  assert.equal(projectRun(cached.value.origin.stateDir!,cached.value.origin.runId)!.requests[0].result!.verdict,'GREEN');
});

test('production Broker never reuses or coalesces requests without an identity function', async t => {
  const f=await fixture(t), a=await f.repo('plain',null);
  for(let i=0;i<2;i++){const run=await a.broker.submitProject({selection:{kind:'all'}});await a.broker.run(run.id);assert.equal(a.broker.getRun(run.id)!.status,'GREEN');}
  assert.equal((await readFile(f.count,'utf8')).trim().split('\n').length,2);
  assert.equal(existsSync(join(f.root,'home','identity-cache','cache.sqlite')),false);
  const plan=await inspectProject({repoPath:a.repoPath,stateDir:a.stateDir,selection:{kind:'all'}});
  assert.equal(plan.plan.counts.reuse,0);assert.equal(plan.plan.counts.execute,1);
});

test('canceling the initiating Run leaves another repository subscriber and its real execution alive', async t => {
  const f=await fixture(t), a=await f.repo('owner','shared-cancel',true), b=await f.repo('subscriber','shared-cancel');
  t.after(()=>writeFile(join(f.root,'release'),'release').catch(()=>{}));
  const first=await a.broker.submitProject({selection:{kind:'all'}}), runningA=a.broker.run(first.id);
  await f.until(()=>existsSync(f.count));
  const second=await b.broker.submitProject({selection:{kind:'all'}}), runningB=b.broker.run(second.id);
  await f.until(()=>b.broker.getRun(second.id)!.requests[0].cacheDisposition==='coalesced');
  a.broker.cancel(first.id);await runningA;
  assert.equal(a.broker.getRun(first.id)!.status,'ERROR');
  assert.equal(b.broker.executionBudget(second.id)!.attempts.length,0);
  await writeFile(join(f.root,'release'),'release');await runningB;
  assert.equal(b.broker.getRun(second.id)!.status,'GREEN');
  assert.equal((await readFile(f.count,'utf8')).trim(),'owner');
  assert.equal(readIdentityCache('shared-cancel')!.value.result.verdict,'GREEN');
});

test('a shared Human review is claimed and completed from a different repository after initiator cancellation', async t => {
  const f=await fixture(t), a=await f.repo('human-a','shared-human'), b=await f.repo('human-b','shared-human');
  for(const item of [a,b]) {
    const file=join(item.repoPath,'ccdd.json'), manifest=JSON.parse(await readFile(file,'utf8'));
    manifest.critics[0].profile={kind:'human'};
    manifest.views={humanTools:{read:{metadata:{description:'Read the controlled fixture.',inputSchema:{type:'object',properties:{},additionalProperties:false},resultKinds:['text'],observation:'content'},script:{command:'node',args:['read.mjs']}}}};
    await writeFile(file,JSON.stringify(manifest));
    await writeFile(join(item.repoPath,'read.mjs'),`console.log(JSON.stringify({content:[{type:'text',text:'Actual Human fixture'}],observation:{kind:'content'}}));`);
  }
  const first=await a.broker.submitProject({selection:{kind:'all'}}), runningA=a.broker.run(first.id);
  await f.until(()=>a.broker.getRun(first.id)!.requests[0].notifiedAt!=null);
  const second=await b.broker.submitProject({selection:{kind:'all'}}), runningB=b.broker.run(second.id);
  await f.until(()=>b.broker.getRun(second.id)!.requests[0].notifiedAt!=null);
  a.broker.cancel(first.id);await runningA;
  const id=b.broker.getRun(second.id)!.requests[0].id;
  await b.broker.claimHuman(id,'reviewer');
  const observed=await b.broker.executeHumanTool(id,{reviewerId:'reviewer',toolName:'read_human-a',arguments:{}});
  assert.equal(observed.observation?.kind,'content');
  await assert.rejects(b.broker.completeHuman(id,{reviewerId:'intruder',result:{verdict:'GREEN'}}),/claimed/);
  await b.broker.completeHuman(id,{reviewerId:'reviewer',result:{verdict:'GREEN'}});await runningB;
  assert.equal(b.broker.getRun(second.id)!.status,'GREEN');
  assert.equal(readIdentityCache('shared-human')!.value.profile.kind,'human');
});

test('force executes actual new work and atomically replaces the reusable result without changing its identity', async t => {
  const f=await fixture(t), a=await f.repo('forced','force-value');
  const first=await a.broker.submitProject({selection:{kind:'all'}});await a.broker.run(first.id);
  const original=readIdentityCache('force-value')!;
  await writeFile(join(a.repoPath,'check.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('actual failure',()=>assert.fail('Controlled RED'));\n");
  const forced=await a.broker.submitProject({selection:{kind:'all'},force:true});await a.broker.run(forced.id);
  assert.equal(a.broker.getRun(forced.id)!.status,'RED');
  const replaced=readIdentityCache('force-value')!;
  assert.equal(replaced.value.result.verdict,'RED');assert.notEqual(replaced.executionId,original.executionId);
  const reused=await a.broker.submitProject({selection:{kind:'all'}});
  assert.equal(reused.status,'RED');assert.equal(reused.requests[0].cacheDisposition,'hit');
});
