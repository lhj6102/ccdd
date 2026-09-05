import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {main} from '../src/cli.mjs';
import {startServer} from '../src/server.mjs';
import {prepareDemo} from '../scripts/prepare-demo.mjs';
import {createExecutorRegistry} from '../src/executors/index.mjs';

async function invoke(args){
  let output='',errors='';
  const code=await main(args,{stdout:{write:text=>{output+=text;}},stderr:{write:text=>{errors+=text;}}});
  return {code,output,errors,data:output.startsWith('{')||output.startsWith('[')?JSON.parse(output):null};
}
async function fixture(t,executors,diagnose){
  const dir=await mkdtemp(join(tmpdir(),'ccdd-cli-'));
  const manifest=await prepareDemo({root:join(dir,'demo')});
  const app=await startServer({repoPath:manifest.repoPath,manifest,stateDir:join(dir,'state'),port:0,executors,diagnose});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {...app,manifest};
}
const green={verdict:'GREEN',summary:'Selected criterion is met.',evidence:['Fixture artifact review.']};

test('CLI executes through the symlink used by npm-installed bin commands',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ccdd-cli-bin-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const bin=join(dir,'ccdd');
  await symlink(fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),bin);
  const {stdout}=await promisify(execFile)(process.execPath,[bin,'help']);
  assert.match(stdout,/CCDD \d+\.\d+\.\d+/);assert.match(stdout,/ccdd doctor/);
});

test('builder CLI waits for the selected real runtime and distinguishes GREEN from RED',async t=>{
  const actual=createExecutorRegistry();
  const executors={...actual,canExecute:request=>request.profile.kind==='agent'?{ok:false,reason:'No Agent configured in this runtime-only fixture'}:actual.canExecute(request)};
  const app=await fixture(t,executors);
  for(const [scenario,expected] of [['baseline',0],['runtime-failure',1]]){
    const commit=app.manifest.scenarios.find(x=>x.id===scenario).commit;
    const result=await invoke(['run','--url',app.url,'--commit',commit,'--critic','implementation-tests','--wait','--json']);
    assert.equal(result.code,expected,result.errors);
    assert.deepEqual(result.data.scope,{kind:'critic',criticId:'implementation-tests'});
    assert.equal(result.data.requests.length,1);
    assert.equal(result.data.requests[0].result.exitCode,expected);
    assert.equal(result.data.requests[0].predecessorId,null);
    assert.match(result.errors,new RegExp(result.data.id));
  }
});

test('builder CLI reports operational ERROR as exit 2 with a persisted handle',async t=>{
  const app=await fixture(t,{canExecute:()=>({ok:true}),execute:async()=>{throw new Error('Provider unavailable in fixture');}});
  const result=await invoke(['run','--url',app.url,'--commit',app.manifest.scenarios[0].commit,'--critic','tests-spec','--wait']);
  assert.equal(result.code,2);
  assert.equal(result.data.status,'ERROR');
  assert.match(result.data.requests[0].error,/Provider unavailable/);
  assert.equal(app.broker.listRuns().length,1);
});

test('wait timeout returns exit 3 without losing the handle; status can await its later result',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const app=await fixture(t,{canExecute:()=>({ok:true}),execute:async()=>{await gate;return green;}});
  t.after(()=>release());
  const first=await invoke(['run','--url',app.url,'--commit',app.manifest.scenarios[0].commit,'--critic','tests-spec','--wait','--timeout-ms','25']);
  assert.equal(first.code,3,first.errors);
  assert.equal(first.data.wait.completed,false);
  assert.ok(app.broker.getRun(first.data.id));
  release();
  const finished=await invoke(['status','--url',app.url,first.data.id,'--wait']);
  assert.equal(finished.code,0);
  assert.equal(finished.data.status,'GREEN');
  assert.equal(app.broker.listRuns().length,1);
});

test('without wait, CLI acceptance returns a queued handle and rejects invalid critic names',async t=>{
  const app=await fixture(t,{canExecute:()=>({ok:true}),execute:async()=>green});
  const commit=app.manifest.scenarios[0].commit;
  const accepted=await invoke(['run','--url',app.url,'--commit',commit,'--critic','tests-spec']);
  assert.equal(accepted.code,0);assert.equal(accepted.data.status,'QUEUED');
  const invalid=await invoke(['run','--url',app.url,'--commit',commit,'--critic','missing','--json']);
  assert.equal(invalid.code,2);assert.ok(invalid.data.error);
  assert.equal(app.broker.listRuns().length,1);
});

test('doctor CLI forwards the selected scope to daemon diagnosis and returns machine-readable readiness',async t=>{
  const calls=[];
  const app=await fixture(t,{canExecute:()=>({ok:true}),execute:async()=>green},async input=>{
    calls.push(input);
    return {ok:false,status:'NOT_READY',repoId:input.repoId,snapshotCommit:input.snapshotCommit,scope:{kind:'critic',criticId:input.criticId},checks:[{id:'provider',status:'FAIL',message:'Authentication failed in diagnostic fixture.',remedy:'Log in to the configured provider.'}]};
  });
  const commit=app.manifest.scenarios[0].commit;
  const result=await invoke(['doctor','--url',app.url,'--commit',commit,'--critic','tests-spec','--json']);
  assert.equal(result.code,1);assert.equal(result.data.status,'NOT_READY');
  assert.equal(calls[0].criticId,'tests-spec');assert.equal(calls[0].snapshotCommit,commit);
  assert.deepEqual(app.broker.listRuns(),[]);
  const text=await invoke(['doctor','--url',app.url,'--commit',commit]);
  assert.equal(text.code,1);assert.match(text.output,/조치:/);
});

test('CLI validates wait arguments and explains exit semantics',async()=>{
  const invalid=await invoke(['run','--commit','a'.repeat(40),'--wait','--timeout-ms','NaN','--json']);
  assert.equal(invalid.code,2);assert.match(invalid.data.error,/timeout-ms/);
  const missing=await invoke(['run','--critic','--wait','--json']);
  assert.equal(missing.code,2);assert.match(missing.errors,/requires a value/);
  const help=await invoke(['help']);assert.equal(help.code,0);assert.match(help.output,/0=GREEN, 1=RED, 2=ERROR, 3=wait timed out/);
});
