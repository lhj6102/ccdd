import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { inspectProject, projectRun, readIdentityCache } from '../src/project/index.js';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';

async function until(predicate:()=>boolean|Promise<boolean>) {
  const deadline=Date.now()+10000;
  while(!await predicate()){assert.ok(Date.now()<deadline,'Execution barrier timed out');await delay(10);}
}
async function fixture(t:test.TestContext) {
  const data=await artifactFixture(t); await data.write('a',{name:'a',critics:[runtimeCritic()]});
  await data.identity('a'); return data;
}
// Former project-local submission-grace tests are replaced by the real shared
// computation contract: a submitted-but-unstarted Run does not reserve an identity.
for(const verdict of ['GREEN','RED'] as const) test(`explicit ${verdict} evidence is shared, and force bypass never replaces it`,async t=>{
  const data=await fixture(t);let calls=0,release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async()=>{calls++;await gate;return{verdict};}}});
  data.cleanup(async()=>{release();await broker.close();});
  const source=await broker.submitProject({selection:{kind:'all'}}),running=broker.run(source.id);await until(()=>calls===1);
  const follower=await broker.submitProject({selection:{kind:'all'},maxExecutions:0}),waiting=broker.run(follower.id);
  await until(()=>broker.getRun(follower.id)!.requests[0].cacheDisposition==='coalesced');
  assert.equal(calls,1);release();assert.equal((await running)!.status,verdict);assert.equal((await waiting)!.status,verdict);
  assert.equal(broker.executionBudget(follower.id)!.attempts.length,0);
  const sourceRecord=broker.getRun(source.id)!.requests[0];
  const hit=await broker.submitProject({selection:{kind:'all'},maxExecutions:0});
  assert.equal(hit.status,verdict);assert.equal(hit.requests[0].cacheDisposition,'hit');
  assert.equal(hit.requests[0].executionSource!.executionId,sourceRecord.executionSource!.executionId);
  const plan=await inspectProject({...data,detail:'full'});assert.equal(plan.plan.items[0].action,'REUSE');assert.equal(plan.plan.satisfied,verdict==='GREEN');
  const forced=await broker.submitProject({selection:{kind:'all'},force:true});await broker.run(forced.id);assert.equal(calls,2);
  assert.equal(readIdentityCache(sourceRecord.validationInput!.cacheIdentity!)!.executionId,sourceRecord.executionSource!.executionId);
});

test('unstarted submissions do not create hidden grace-period reservations or bypass a zero budget',async t=>{
  const data=await fixture(t),broker=createBroker({...data,executors:{canExecute:()=>({ok:true}),execute:async()=>({verdict:'GREEN'})}});data.cleanup(()=>broker.close());
  const pending=await broker.submitProject({selection:{kind:'all'},maxExecutions:1});
  await assert.rejects(broker.submitProject({selection:{kind:'all'},maxExecutions:0}),{code:'EXECUTION_BUDGET_EXCEEDED'});
  broker.cancel(pending.id);const next=await broker.submitProject({selection:{kind:'all'},maxExecutions:1});
  assert.equal((await broker.run(next.id))!.status,'GREEN');
});

for(const cancel of ['initiator','follower'] as const)test(`canceling the ${cancel} detaches only its subscription`,async t=>{
  const data=await fixture(t);let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async()=>{calls++;await gate;return{verdict:'GREEN'};}}});
  data.cleanup(async()=>{release();await broker.close();});
  const first=await broker.submitProject({selection:{kind:'all'}}),one=broker.run(first.id);await until(()=>calls===1);
  const second=await broker.submitProject({selection:{kind:'all'}}),two=broker.run(second.id);await until(()=>broker.getRun(second.id)!.requests[0].cacheDisposition==='coalesced');
  broker.cancel(cancel==='initiator'?first.id:second.id);release();await Promise.all([one,two]);
  assert.equal(broker.getRun(cancel==='initiator'?first.id:second.id)!.status,'ERROR');
  assert.equal(broker.getRun(cancel==='initiator'?second.id:first.id)!.status,'GREEN');assert.equal(calls,1);
});

test('all subscriber cancellations reject a late successful result and a later request executes again',async t=>{
  const data=await fixture(t);let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async()=>{calls++;await gate;return{verdict:'GREEN'};}}});
  data.cleanup(async()=>{release();await broker.close();});
  const first=await broker.submitProject({selection:{kind:'all'}}),one=broker.run(first.id);await until(()=>calls===1);
  const second=await broker.submitProject({selection:{kind:'all'}}),two=broker.run(second.id);await until(()=>broker.getRun(second.id)!.requests[0].cacheDisposition==='coalesced');
  broker.cancel(first.id);broker.cancel(second.id);await Promise.all([one,two]);release();
  const key=first.requests[0].validationInput!.cacheIdentity!;
  // A new cache request waits for the canceled attempt to settle; it cannot hit a late GREEN.
  await until(()=>!readIdentityCache(key));
  const next=await broker.submitProject({selection:{kind:'all'}});assert.equal((await broker.run(next.id))!.status,'GREEN');assert.equal(calls,2);
});

test('without identity, simultaneous requests neither share work nor reuse history',async t=>{
  const data=await artifactFixture(t);await data.write('a',{name:'a',critics:[runtimeCritic()]});
  let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async()=>{calls++;await gate;return{verdict:'GREEN'};}}});
  data.cleanup(async()=>{release();await broker.close();});
  const first=await broker.submitProject({selection:{kind:'all'}}),second=await broker.submitProject({selection:{kind:'all'}});
  const one=broker.run(first.id),two=broker.run(second.id);await until(()=>calls===2);release();await Promise.all([one,two]);
  assert.equal((await inspectProject(data)).plan.counts.reuse,0);
});

async function processWorker(t:test.TestContext,data:{repoPath:string;stateDir:string},runId:string,marker:string) {
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import {createBroker} from ${JSON.stringify(new URL('../src/broker/index.js',import.meta.url).href)};
    import {appendFileSync} from 'node:fs';
    const broker=createBroker({...${JSON.stringify({repoPath:data.repoPath,stateDir:data.stateDir})},executors:{canExecute:()=>({ok:true}),execute:async()=>{
      appendFileSync(${JSON.stringify(marker)},'start\\n');process.send('executing');await new Promise(()=>{});return{verdict:'GREEN'};}}});
    process.send('ready');process.once('message',async()=>{await broker.run(${JSON.stringify(runId)});await broker.close();process.disconnect();});
  `],{stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr!.on('data',chunk=>errors+=chunk);const exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
  assert.equal((await once(child,'message'))[0],'ready',errors);const started=once(child,'message');child.send('go');assert.equal((await started)[0],'executing',errors);
  return{child,exit};
}

for(const budget of [0,1])test(`dead cross-process owners never donate their execution budget (receiver cap ${budget})`,{timeout:15000},async t=>{
  const data=await fixture(t);let starts=0;
  const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async()=>{starts++;return{verdict:'GREEN'};}}});data.cleanup(()=>broker.close());
  const first=await broker.submitProject({selection:{kind:'all'},maxExecutions:1});const marker=join(data.root,'started');const source=await processWorker(t,data,first.id,marker);
  const second=await broker.submitProject({selection:{kind:'all'},maxExecutions:budget}),waiting=broker.run(second.id);await until(()=>broker.getRun(second.id)!.requests[0].cacheDisposition==='coalesced');
  source.child.kill('SIGKILL');await source.exit;const result=(await waiting)!;
  assert.equal(result.status,budget?'GREEN':'ERROR');assert.equal(starts,budget);assert.equal(broker.executionBudget(second.id)!.attempts.length,budget);
  if(!budget)assert.equal(result.requests[0].errorCode,'EXECUTION_BUDGET_EXHAUSTED');
  assert.equal(await readFile(marker,'utf8'),'start\n');assert.equal(projectRun(data.stateDir,first.id)!.requests[0].result,null);
});

test('first matching request after a killed owner recovers without borrowing its abandoned Run', {timeout:15000},async t=>{
  const data=await fixture(t);let starts=0;const broker=createBroker({...data,detail:'full',executors:{canExecute:()=>({ok:true}),execute:async()=>{starts++;return{verdict:'GREEN'};}}});data.cleanup(()=>broker.close());
  const first=await broker.submitProject({selection:{kind:'all'}}),source=await processWorker(t,data,first.id,join(data.root,'started'));source.child.kill('SIGKILL');await source.exit;
  const next=await broker.submitProject({selection:{kind:'all'},maxExecutions:1});assert.equal((await broker.run(next.id))!.status,'GREEN');assert.equal(starts,1);
  assert.notEqual(broker.getRun(next.id)!.requests[0].executionSource!.runId,first.id);
});
