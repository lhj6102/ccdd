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
import { projectRun, projectRequestData } from '../src/project/store.js';
import { describeReviewTools } from '../src/tools/runner.js';

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
  const follower=b.broker.getRun(second.id)!.requests[0], id=follower.id, source=follower.executionSource!;
  // The monitor advertises the shared execution's tools, which are the ones Human actions route to.
  const shared=projectRequestData(source.stateDir,source.requestId)!;
  const [tool]=describeReviewTools({artifacts:shared.artifacts,configManifest:shared.configManifest,audience:'human'});
  assert.equal(tool.name,'read_human-a');
  await b.broker.claimHuman(id,'reviewer');
  const observed=await b.broker.executeHumanTool(id,{reviewerId:'reviewer',toolName:tool.name,arguments:{}});
  assert.equal(observed.observation?.kind,'content');
  await assert.rejects(b.broker.completeHuman(id,{reviewerId:'intruder',result:{verdict:'GREEN'}}),/claimed/);
  await b.broker.completeHuman(id,{reviewerId:'reviewer',result:{verdict:'GREEN'}});await runningB;
  assert.equal(b.broker.getRun(second.id)!.status,'GREEN');
  assert.equal(readIdentityCache('shared-human')!.value.profile.kind,'human');
});

test('force bypasses one call without replacing another caller identity result', async t => {
  const f=await fixture(t), a=await f.repo('forced','force-value');
  const first=await a.broker.submitProject({selection:{kind:'all'}});await a.broker.run(first.id);
  const original=readIdentityCache('force-value')!;
  await writeFile(join(a.repoPath,'check.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('actual failure',()=>assert.fail('Controlled RED'));\n");
  const forced=await a.broker.submitProject({selection:{kind:'all'},force:true});await a.broker.run(forced.id);
  assert.equal(a.broker.getRun(forced.id)!.status,'RED');
  const replaced=readIdentityCache('force-value')!;
  assert.equal(replaced.value.result.verdict,'GREEN');assert.equal(replaced.executionId,original.executionId);
  const reused=await a.broker.submitProject({selection:{kind:'all'}});
  assert.equal(reused.status,'GREEN');assert.equal(reused.requests[0].cacheDisposition,'hit');
});

test('prepared submission reuses identity values in one session and rejects changed or forged preparation', async t => {
  const f=await fixture(t), a=await f.repo('prepared','prepared-value'), identityCalls=join(f.root,'identity-calls');
  await writeFile(join(a.repoPath,'identity.mjs'),`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(identityCalls)},'identity\\n');console.log('prepared-value');`);
  const prepared=await a.broker.prepareProject({selection:{kind:'all'}});
  assert.equal((await readFile(identityCalls,'utf8')).trim(),'identity');
  prepared.plan.selection={kind:'critic',criticId:'not/a-critic'};
  const run=await a.broker.submitPrepared(prepared);
  assert.equal((await readFile(identityCalls,'utf8')).trim(),'identity','submission reuses the prepared identity');
  await a.broker.run(run.id);
  assert.equal(a.broker.getRun(run.id)!.status,'GREEN');
  // The cache-owned execution re-runs its identity once, before accepting its result.
  assert.equal((await readFile(identityCalls,'utf8')).trim(),'identity\nidentity');
  await assert.rejects(a.broker.submitPrepared(structuredClone(prepared)),/Unknown or disposed/);
  const before=a.broker.listRuns().length;
  await writeFile(join(a.repoPath,'new-material'),'changed');
  await assert.rejects(a.broker.submitPrepared(prepared),/changed/i);
  assert.equal(a.broker.listRuns().length,before);
});

test('declared request-time profiles preserve source bytes and distinguish requested from reused profiles', async t => {
  const f=await fixture(t), a=await f.repo('variants','profile-value');
  const manifestPath=join(a.repoPath,'ccdd.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.critics[0].profileVariants={patient:{...manifest.critics[0].profile,timeoutMs:20000}};
  await writeFile(manifestPath,JSON.stringify(manifest));const original=await readFile(manifestPath);
  await assert.rejects(a.broker.prepareProject({selection:{kind:'all'},profile:'unknown'}),/Unknown profile/);
  const prepared=await a.broker.prepareProject({selection:{kind:'all'},profile:'patient'});
  const first=await a.broker.submitPrepared(prepared);await a.broker.run(first.id);
  const result=a.broker.getRun(first.id)!.requests[0];assert.equal(Reflect.get(result.profile,'timeoutMs'),20000);
  const reused=await a.broker.submitProject({selection:{kind:'all'}});
  assert.equal(reused.status,'GREEN');assert.equal(Reflect.get(reused.requests[0].profile,'timeoutMs'),20000);
  assert.equal(Reflect.get(reused.requests[0].requestedProfile!,'timeoutMs'),15000);
  assert.deepEqual(await readFile(manifestPath),original);
});

test('plan and zero-budget submission attach to actual shared work without scheduling another execution', async t => {
  const f=await fixture(t), a=await f.repo('active-owner','active-value',true), b=await f.repo('active-follower','active-value');
  t.after(()=>writeFile(join(f.root,'release'),'release').catch(()=>{}));
  const first=await a.broker.submitProject({selection:{kind:'all'}}), pendingA=a.broker.run(first.id);
  await f.until(()=>existsSync(f.count));
  const plan=await inspectProject({repoPath:b.repoPath,stateDir:b.stateDir,selection:{kind:'all'}});assert.equal(plan.plan.counts.coalesce,1);
  const next=await b.broker.submitProject({selection:{kind:'all'},maxExecutions:0}), pendingB=b.broker.run(next.id);
  await f.until(()=>b.broker.getRun(next.id)!.requests[0].cacheDisposition==='coalesced');
  await writeFile(join(f.root,'release'),'release');await Promise.all([pendingA,pendingB]);
  assert.equal(b.broker.getRun(next.id)!.status,'GREEN');assert.equal(b.broker.executionBudget(next.id)!.attempts.length,0);
});

test('terminal result iterator preserves attribution, finishes without a poll delay and never double-counts reuse', async t => {
  const f=await fixture(t), a=await f.repo('stream','stream-value');
  const run=await a.broker.submitProject({selection:{kind:'all'}});
  const received:unknown[]=[];const reader=(async()=>{for await(const entry of a.broker.results(run.id,{pollIntervalMs:10}))received.push(entry);})();
  await a.broker.run(run.id);await reader;
  assert.equal(received.length,1);const record=received[0] as Record<string,any>;
  assert.equal(record.type,'result');assert.equal(record.criticId,'stream/review');assert.equal(record.inputKey,'stream-value');
  assert.equal(record.status,'GREEN');assert.equal(record.profile.kind,'runtime');assert.equal(record.usageState,'unreported');assert.equal(Object.hasOwn(record,'usage'),false);
  assert.equal(record.executionSource.executionId,a.broker.getRun(run.id)!.requests[0].executionSource!.executionId);
  const summary=a.broker.runSummary(run.id)!;assert.equal(summary.executorStarts,1);assert.equal(summary.usageState,'unreported');
  const reused=await a.broker.submitProject({selection:{kind:'all'},maxExecutions:0});
  const hits=[];for await(const entry of a.broker.results(reused.id))hits.push(entry);
  assert.equal(hits.length,1);assert.equal(hits[0].cacheDisposition,'hit');assert.equal(a.broker.runSummary(reused.id)!.executorStarts,0);
  const replay=[];for await(const entry of a.broker.results(run.id,{after:record.cursor}))replay.push(entry);assert.equal(replay.length,0);
});

test('closing an iterator or aborting its wait leaves the live computation untouched', async t => {
  const f=await fixture(t), a=await f.repo('stream-owner','stream-cancel',true);
  t.after(()=>writeFile(join(f.root,'release'),'release').catch(()=>{}));
  const run=await a.broker.submitProject({selection:{kind:'all'}}), pending=a.broker.run(run.id);await f.until(()=>existsSync(f.count));
  const abort=new AbortController(), iterator=a.broker.results(run.id,{signal:abort.signal,pollIntervalMs:10});
  const waiting=iterator.next();abort.abort(new Error('Reader stopped'));await assert.rejects(waiting,/Reader stopped|aborted/);
  assert.equal(a.broker.getRun(run.id)!.status,'RUNNING');await writeFile(join(f.root,'release'),'release');await pending;
  assert.equal(a.broker.getRun(run.id)!.status,'GREEN');
});

test('GC reclaims retired execution audit directories but preserves retained source results', async t => {
  const {openIdentityCache,identityCacheDirectory}=await import('../src/cache/index.js');
  const f=await fixture(t),a=await f.repo('gc-first','gc-first'),b=await f.repo('gc-second','gc-second');
  for(const item of [a,b]){const run=await item.broker.submitProject({selection:{kind:'all'}});await item.broker.run(run.id);}
  const first=readIdentityCache('gc-first')!,second=readIdentityCache('gc-second')!;
  assert.ok(existsSync(first.value.origin.stateDir!));assert.ok(existsSync(second.value.origin.stateDir!));
  const collector=openIdentityCache({directory:identityCacheDirectory(),maxEntries:1});t.after(()=>collector.close());
  const gc=await collector.gc({limit:1});assert.equal(gc.removed,1);assert.equal(gc.entries,1);
  assert.equal(readIdentityCache('gc-first'),null);assert.equal(existsSync(first.value.origin.stateDir!),false);
  assert.ok(existsSync(second.value.origin.stateDir!));assert.equal(readIdentityCache('gc-second')!.executionId,second.executionId);
});

test('source usage mirrored while running is not added again at terminal publication',async t=>{
  const {artifactFixture,runtimeCritic}=await import('./helpers/artifacts.js');
  const data=await artifactFixture(t);await data.write('a',{name:'a',critics:[runtimeCritic()]});await data.identity('a');
  const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async(_request,{onEvent})=>{
    await onEvent?.({type:'executor.usage',usage:{input:3,totalTokens:3}});await delay(180);
    await onEvent?.({type:'executor.usage',usage:{input:5,totalTokens:5}});await delay(180);return{verdict:'GREEN'};
  }}});data.cleanup(()=>broker.close());
  const run=await broker.submitProject({selection:{kind:'all'}});await broker.run(run.id);
  assert.equal(broker.getRun(run.id)!.requests[0].usage!.totalTokens,8);assert.equal(broker.runSummary(run.id)!.usage!.totalTokens,8);
  const hit=await broker.submitProject({selection:{kind:'all'},maxExecutions:0});assert.equal(hit.requests[0].usage!.totalTokens,8);
  assert.equal(broker.runSummary(hit.id)!.executorStarts,0);assert.equal(broker.runSummary(hit.id)!.usage,undefined);
});

async function controlledRepo(root: string, name: string, files: Record<string, unknown>) {
  const repoPath = join(root, name); await mkdir(repoPath, { recursive: true });
  for (const [file, content] of Object.entries(files)) { await mkdir(join(repoPath, file, '..'), { recursive: true }); await writeFile(join(repoPath, file), typeof content === 'string' ? content : JSON.stringify(content)); }
  return repoPath;
}
const runtimeCritic = (timeoutMs = 15000) => ({ id: 'check', title: 'Check', profile: { kind: 'runtime', command: 'node', args: ['--test', 'check.test.mjs'], timeoutMs }, payload: { instruction: 'Check.' } });
const identityStale = { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } };

test('root reviewPolicy.maxConcurrentExecutors also caps cache-owned executions', async t => {
  const f = await fixture(t), files: Record<string, unknown> = { 'ccdd.json': { name: 'root', reviewPolicy: { maxConcurrentExecutors: 1 } } };
  for (let i = 0; i < 3; i++) Object.assign(files, { [`a${i}/ccdd.json`]: { name: `a${i}`, stale: identityStale, critics: [runtimeCritic()] }, [`a${i}/identity.mjs`]: `console.log('cap-${i}');` });
  const repoPath = await controlledRepo(f.root, 'capped', files);
  let active = 0, peak = 0;
  const broker = createBroker({ repoPath, stateDir: join(f.root, 'capped-state'), repoId: 'capped', detail: 'full',
    executors: { canExecute: () => ({ ok: true }), execute: async () => { active++; peak = Math.max(peak, active); await delay(150); active--; return { verdict: 'GREEN' }; } } as never });
  t.after(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } }); await broker.run(run.id);
  assert.equal(broker.getRun(run.id)!.requests.filter(request => request.cacheDisposition === 'executed').length, 3);
  assert.equal(peak, 1);
});

test('retrying a failed coalesced subscriber executes its own requested profile', async t => {
  const f = await fixture(t), timeouts: number[] = [];
  let releaseOwner!: () => void; const released = new Promise<void>(resolve => { releaseOwner = resolve; });
  const repo = (name: string, timeoutMs: number) => controlledRepo(f.root, name, { 'ccdd.json': { name, stale: identityStale, critics: [runtimeCritic(timeoutMs)] }, 'identity.mjs': `console.log('retry-shared');` });
  const a = createBroker({ repoPath: await repo('owner', 1000), stateDir: join(f.root, 'owner-state'), repoId: 'owner', detail: 'full',
    executors: { canExecute: () => ({ ok: true }), execute: async () => { await released; throw Error('Controlled operational failure'); } } as never });
  const b = createBroker({ repoPath: await repo('follower', 9999), stateDir: join(f.root, 'follower-state'), repoId: 'follower', detail: 'full',
    executors: { canExecute: () => ({ ok: true }), execute: async (request: { profile: { timeoutMs: number } }) => { timeouts.push(request.profile.timeoutMs); return { verdict: 'GREEN' }; } } as never });
  t.after(async () => { await a.close(); await b.close(); });
  const first = await a.submitProject({ selection: { kind: 'all' } }), runningA = a.run(first.id);
  await f.until(() => Boolean(a.getRun(first.id)!.requests[0].attemptId));
  const second = await b.submitProject({ selection: { kind: 'all' } }), runningB = b.run(second.id);
  await f.until(() => b.getRun(second.id)!.requests[0].cacheDisposition === 'coalesced');
  releaseOwner(); await Promise.all([runningA, runningB]);
  const failed = b.getRun(second.id)!.requests[0];
  assert.equal(failed.status, 'ERROR');
  b.retryRequest(failed.id); await b.run(second.id);
  assert.deepEqual(timeouts, [9999]);
  assert.equal((b.getRun(second.id)!.requests[0].profile as { timeoutMs?: number }).timeoutMs, 9999);
});

test('a canceled initiating worker keeps serving the shared execution until it completes', async t => {
  const f=await fixture(t), a=await f.repo('drain-owner','shared-drain',true), b=await f.repo('drain-follower','shared-drain');
  t.after(()=>writeFile(join(f.root,'release'),'release').catch(()=>{}));
  const first=await a.broker.submitProject({selection:{kind:'all'}}), runningA=a.broker.run(first.id);
  await f.until(()=>existsSync(f.count));
  const second=await b.broker.submitProject({selection:{kind:'all'}}), runningB=b.broker.run(second.id);
  await f.until(()=>b.broker.getRun(second.id)!.requests[0].cacheDisposition==='coalesced');
  a.broker.cancel(first.id);await runningA;
  let drained=false; const draining=a.broker.drainShared().then(()=>{drained=true;});
  await delay(300); assert.equal(drained,false);
  await writeFile(join(f.root,'release'),'release');await Promise.all([draining,runningB]);
  await a.broker.close();
  assert.equal(b.broker.getRun(second.id)!.status,'GREEN');
  assert.equal((await readFile(f.count,'utf8')).trim(),'drain-owner');
});
