import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {main} from '../src/cli.mjs';
import {createBroker} from '../src/broker/index.mjs';
import {createExecutorRegistry} from '../src/executors/index.mjs';
import {removeOwnedWorkspaceTree} from '../src/workspaces/index.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
async function invoke(args){
  let output='',errors='';
  const code=await main(args,{stdout:{write:text=>{output+=text;}},stderr:{write:text=>{errors+=text;}}});
  return {code,output,errors,data:output.startsWith('{')||output.startsWith('[')?JSON.parse(output):null};
}
async function separate(args){
  try{const result=await promisify(execFile)(process.execPath,[cli,...args],{env:{...process.env,NODE_TEST_CONTEXT:''}});return {code:0,data:JSON.parse(result.stdout)};}
  catch(error){return {code:error.code,data:JSON.parse(error.stdout)};}
}
async function until(read,predicate,timeout=10000){
  const deadline=Date.now()+timeout;
  let value;
  do{value=await read();if(predicate(value))return value;await delay(30);}while(Date.now()<deadline);
  assert.fail(`Timed out: ${JSON.stringify(value)}`);
}
async function fixture(t,{human=false,slow=0,red=false,chain=false}={}){
  const root=await mkdtemp(join(tmpdir(),'ccdd-cli-v3-')),repo=join(root,'repo'),state=join(root,'state');
  await mkdir(repo);
  await writeFile(join(repo,'why.md'),'Review basis.');
  await writeFile(join(repo,'test.mjs'),`import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';import {writeFile} from 'node:fs/promises';import {join} from 'node:path';test('actual runtime',async()=>{await delay(${slow});await writeFile(join(process.env.CCDD_OUTPUT_DIR,'result.txt'),'isolated output');assert.equal(${red?1:0},0);});`);
  const critic={id:'runtime',title:'Runtime',dependsOn:null,artifacts:['tests'],profile:{kind:'runtime',command:'node',args:['--test','test.mjs']},payload:{instruction:'Execute actual tests.'}};
  const humanCritic={id:'human',title:'Human review',dependsOn:null,artifacts:['why'],profile:{kind:'human'},payload:{instruction:'Check the basis.'}};
  const config={artifacts:{tests:{type:'code',path:'test.mjs'},why:{type:'text',path:'why.md'}},artifactTypes:{code:{viewer:'files'},text:{viewer:'text'}},critics:chain?[humanCritic,{...critic,dependsOn:'human'}]:[human?humanCritic:critic]};
  await writeFile(join(repo,'ccdd.config.json'),JSON.stringify(config));
  const args=['--repo',repo,'--state-dir',state,'--json'];
  t.after(async()=>{
    let broker;
    try{
      broker=createBroker({repoPath:repo,stateDir:state,repoId:'local'});
      for(const run of broker.listRuns())if(!['GREEN','RED','ERROR'].includes(run.status))broker.cancel(run.id);
      await until(()=>broker.listRuns(),runs=>runs.every(run=>!run.owner),5000);
    }finally{await broker?.close();await removeOwnedWorkspaceTree(root);}
  });
  const status=id=>invoke(['status',id,...args]).then(x=>x.data);
  return {root,repo,state,args,status};
}

test('npm bin symlink invokes CLI without starting a server',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ccdd-bin-'));t.after(()=>removeOwnedWorkspaceTree(dir));
  const bin=join(dir,'ccdd');await symlink(cli,bin);
  const {stdout}=await promisify(execFile)(process.execPath,[bin,'help']);
  assert.match(stdout,/CCDD 0[.]3[.]0/);assert.match(stdout,/No daemon/);assert.doesNotMatch(stdout,/ccdd serve/);
});

test('CLI requires explicit exclusive workspace modes and rejects removed options',async()=>{
  for(const args of [['run'],['run','--lock','--copy'],['run','--copy','--commit','HEAD'],['serve'],['run','--copy','--timeout-ms','NaN']]){
    const result=await invoke([...args,'--json']);assert.equal(result.code,2);assert.ok(result.data.error);
  }
});

test('real runtime succeeds or fails without Git, commit or HTTP server',async t=>{
  for(const red of [false,true]){
    const f=await fixture(t,{red});
    const result=await invoke(['run','--copy','--critic','runtime','--wait',...f.args]);
    assert.equal(result.code,red?1:0,result.output+result.errors);
    assert.equal(result.data.requests.length,1);assert.equal(result.data.requests[0].predecessorId,null);
    assert.equal(result.data.snapshotHash.length,64);assert.equal(result.data.workspace.mode,'copy');
    assert.equal(result.data.requests[0].result.exitCode,red?1:0);
  }
});

test('review continues after submitting CLI exits and original changes cannot alter its copy',async t=>{
  const f=await fixture(t,{slow:500});
  const first=await separate(['run','--copy',...f.args]);assert.equal(first.code,0,JSON.stringify(first));
  await writeFile(join(f.repo,'why.md'),'Changed after capture.');
  const final=await until(()=>f.status(first.data.id),run=>['GREEN','RED','ERROR'].includes(run.status));
  assert.equal(final.status,'GREEN',JSON.stringify(final));
  assert.equal(await readFile(join(final.workspace.path,'why.md'),'utf8'),'Review basis.');
});

test('simultaneous CLI reviews reuse one immutable copy and keep independent runtime output',async t=>{
  const f=await fixture(t,{slow:300});
  const runs=await Promise.all([invoke(['run','--copy','--wait',...f.args]),invoke(['run','--copy','--wait',...f.args])]);
  for(const run of runs)assert.equal(run.code,0,run.output+run.errors);
  assert.notEqual(runs[0].data.id,runs[1].data.id);
  assert.equal(runs[0].data.workspace.path,runs[1].data.workspace.path);
  for(const {data} of runs){
    const path=join(f.state,'runs',data.id,data.requests[0].id,'output','result.txt');
    assert.equal(await readFile(path,'utf8'),'isolated output');
  }
});

test('lock detects changed-and-restored content and invalidates review with ERROR',async t=>{
  const f=await fixture(t,{slow:1500});
  const first=await invoke(['run','--lock',...f.args]);assert.equal(first.code,0,first.output);
  await until(()=>f.status(first.data.id),run=>run.status==='RUNNING');
  await writeFile(join(f.repo,'why.md'),'Temporary change.');await writeFile(join(f.repo,'why.md'),'Review basis.');
  const final=await until(()=>f.status(first.data.id),run=>run.status==='ERROR');
  assert.equal(final.requests[0].errorCode,'WORKSPACE_CHANGED');
  assert.equal(final.requests[0].result,null);
});

test('wait timeout preserves handle and independent worker; status can wait later',async t=>{
  const f=await fixture(t,{slow:500});
  const first=await invoke(['run','--copy','--wait','--timeout-ms','1',...f.args]);
  assert.equal(first.code,3,first.output);assert.equal(first.data.wait.completed,false);
  const final=await invoke(['status',first.data.id,'--wait',...f.args]);
  assert.equal(final.code,0,final.output);assert.equal(final.data.status,'GREEN');
});

test('Human copy waits with no worker and accepts result through fresh CLI processes',async t=>{
  const f=await fixture(t,{human:true});
  const first=await separate(['run','--copy','--human-inbox',...f.args]);assert.equal(first.code,0,JSON.stringify(first));
  const waiting=await until(()=>f.status(first.data.id),run=>run.status==='WAITING_HUMAN'&&!run.owner);
  const request=waiting.requests[0];
  assert.match(await readFile(join(f.state,'human-inbox.jsonl'),'utf8'),new RegExp(request.id));
  const artifact=await separate(['artifact',request.id,'why',...f.args]);assert.equal(artifact.code,0);assert.equal(artifact.data.content,'Review basis.');
  assert.equal((await separate(['human-claim',request.id,'--reviewer','reviewer-a',...f.args])).code,0);
  const file=join(f.root,'result.json');await writeFile(file,JSON.stringify({verdict:'GREEN',summary:'Checked.',evidence:['why.md reviewed.']}));
  const completed=await separate(['human-result',request.id,'--reviewer','reviewer-a','--result-file',file,...f.args]);
  assert.equal(completed.code,0,JSON.stringify(completed));assert.equal(completed.data.status,'GREEN');
  assert.equal((await separate(['human-result',request.id,'--reviewer','reviewer-a','--result-file',file,...f.args])).code,2);
});

test('Human completion automatically starts the next chain request without a daemon',async t=>{
  const f=await fixture(t,{chain:true});
  const first=await invoke(['run','--copy','--human-inbox',...f.args]);assert.equal(first.code,0,first.output);
  const waiting=await until(()=>f.status(first.data.id),run=>run.status==='WAITING_HUMAN'&&run.requests[0].notifiedAt);
  const id=waiting.requests[0].id;
  await invoke(['human-claim',id,'--reviewer','reviewer-a',...f.args]);
  const file=join(f.root,'result.json');await writeFile(file,JSON.stringify({verdict:'GREEN',summary:'Checked.',evidence:['why.md reviewed.']}));
  const final=await invoke(['human-result',id,'--reviewer','reviewer-a','--result-file',file,'--wait',...f.args]);
  assert.equal(final.code,0,final.output);assert.deepEqual(final.data.requests.map(r=>r.status),['GREEN','GREEN']);
});

test('cancel stops an owned review and reports operational failure',async t=>{
  const f=await fixture(t,{slow:4000});
  const first=await invoke(['run','--lock',...f.args]);assert.equal(first.code,0,first.output);
  const canceled=await invoke(['cancel',first.data.id,...f.args]);assert.equal(canceled.code,0,canceled.output);
  assert.equal(canceled.data.status,'ERROR');assert.equal(canceled.data.requests[0].errorCode,'REVIEW_CANCELED');
  await until(()=>f.status(first.data.id),run=>!run.owner);
});


test('worker completes even if startup IPC client disappears before ready',async t=>{
  const f=await fixture(t,{slow:100});
  const broker=createBroker({repoPath:f.repo,stateDir:f.state,repoId:'local',executors:createExecutorRegistry()});
  try{
    const run=await broker.submit({mode:'copy',requesterId:'ipc-regression'});
    const child=fork(fileURLToPath(new URL('../src/worker.mjs',import.meta.url)),[JSON.stringify({repoPath:f.repo,stateDir:f.state,repoId:'local',runId:run.id})],{stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
    let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
    const exit=new Promise((ok,no)=>{child.once('error',no);child.once('exit',(code,signal)=>ok({code,signal}));});
    child.disconnect();
    const result=await exit;assert.equal(result.code,0,errors);
    assert.equal(broker.getRun(run.id).status,'GREEN',JSON.stringify(broker.getRun(run.id)));
  }finally{await broker.close();}
});

test('copy history and Human completion work from state alone after source deletion',async t=>{
  const f=await fixture(t,{human:true});
  const first=await invoke(['run','--copy','--human-inbox',...f.args]);assert.equal(first.code,0,first.output);
  const waiting=await until(()=>f.status(first.data.id),run=>run.status==='WAITING_HUMAN'&&!run.owner);
  await removeOwnedWorkspaceTree(f.repo);
  const args=['--state-dir',f.state,'--json'];
  assert.equal((await separate(['status',first.data.id,...args])).data.status,'WAITING_HUMAN');
  assert.equal((await separate(['artifact',waiting.requests[0].id,'why',...args])).data.content,'Review basis.');
  assert.equal((await separate(['human-claim',waiting.requests[0].id,'--reviewer','reviewer-a',...args])).code,0);
  const file=join(f.root,'result.json');await writeFile(file,JSON.stringify({verdict:'GREEN',summary:'Checked.',evidence:['copied why.md reviewed.']}));
  const final=await separate(['human-result',waiting.requests[0].id,'--reviewer','reviewer-a','--result-file',file,...args]);
  assert.equal(final.code,0,JSON.stringify(final));assert.equal(final.data.status,'GREEN');
});

test('resume of a live worker preserves single ownership and execution',async t=>{
  const f=await fixture(t,{slow:400});
  const first=await invoke(['run','--copy',...f.args]);assert.equal(first.code,0,first.output);
  const second=await invoke(['resume',first.data.id,'--wait',...f.args]);assert.equal(second.code,0,second.output);
  assert.equal(second.data.events.filter(event=>event.type==='request.started').length,1);
});
