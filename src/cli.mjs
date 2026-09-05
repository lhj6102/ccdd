#!/usr/bin/env node
import {resolve,dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareDemo} from '../scripts/prepare-demo.mjs';
import {startServer,createLocalAlarmMethods} from './server.mjs';
import {bundledCodexPath,packageVersion} from './runtime-paths.mjs';
import {createExecutorRegistry} from './executors/index.mjs';
import {diagnoseProject} from './doctor/index.mjs';
import {git} from './broker/config.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const terminal=new Set(['GREEN','RED','ERROR']);
const booleanFlags=new Set(['--demo','--human-inbox','--wait','--json','--help']);
const valueFlags=new Set(['--repo','--manifest','--state-dir','--port','--codex','--url','--commit','--requester','--critic','--timeout-ms']);
function parse(argv){
  const options={},positional=[];
  for(let i=0;i<argv.length;i++){
    const item=argv[i];
    if(booleanFlags.has(item)){options[item]=true;continue;}
    if(valueFlags.has(item)){
      if(options[item]!==undefined)throw new Error(`Duplicate option: ${item}`);
      const value=argv[++i];if(!value||value.startsWith('--'))throw new Error(`${item} requires a value.`);
      options[item]=value;continue;
    }
    if(item.startsWith('-'))throw new Error(`Unknown option: ${item}`);
    positional.push(item);
  }
  return {options,positional};
}
function timeoutValue(value,fallback=600000){
  const ms=value===undefined?fallback:Number(value);
  if(!Number.isSafeInteger(ms)||ms<1||ms>86400000)throw new Error('--timeout-ms must be between 1 and 86400000.');
  return ms;
}
const exitForRun=run=>run.status==='GREEN'?0:run.status==='RED'?1:2;
async function requestJson(url,options={}){
  const response=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(15000)});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error||`HTTP ${response.status}`);
  return body;
}

/** Wait only for the submitted handle. A timeout leaves the broker-owned review intact. */
export async function waitForRun({url,run,timeoutMs=600000,pollMs=500,signal}){
  const deadline=Date.now()+timeoutMs;
  while(!terminal.has(run.status)){
    if(signal?.aborted||Date.now()>=deadline)return {run,completed:false};
    const remaining=deadline-Date.now();
    try{
      await delay(Math.min(pollMs,remaining),undefined,{signal});
      if(Date.now()>=deadline)return {run,completed:false};
      const timeout=AbortSignal.timeout(Math.max(1,Math.min(15000,deadline-Date.now())));
      run=await requestJson(`${url}/api/runs/${encodeURIComponent(run.id)}`,{signal:signal?AbortSignal.any([signal,timeout]):timeout});
    }catch(error){
      if(signal?.aborted||Date.now()>=deadline)return {run,completed:false};
      error.runId=run.id;throw error;
    }
  }
  return {run,completed:true};
}

export async function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  const print=value=>stdout.write(typeof value==='string'?value+'\n':JSON.stringify(value,null,2)+'\n');
  let options={};
  try{
    const command=argv[0]||'help';
    const parsed=parse(argv.slice(1));options=parsed.options;
    const {positional}=parsed;
    const get=(key,fallback)=>options[key]??fallback;
    const json=Boolean(options['--json']);
    const codexPath=get('--codex',process.env.CCDD_CODEX_PATH||bundledCodexPath);
    const stateDir=resolve(get('--state-dir',resolve(root,'.ccdd/state')));
    const repoContext=async()=>{
      if(options['--demo']){const manifest=await prepareDemo();return {manifest,repoPath:manifest.repoPath};}
      const manifestPath=get('--manifest');
      const manifest=manifestPath?JSON.parse(await readFile(manifestPath,'utf8')):undefined;
      return {manifest,repoPath:resolve(get('--repo',process.cwd()))};
    };
    if(command==='help'||command==='--help'||options['--help']){
      print(`CCDD ${packageVersion} — critic broker & artifact runner

  ccdd serve --demo [--port 4317] [--human-inbox]
  ccdd serve --repo PATH [--state-dir PATH] [--codex PATH]
  ccdd doctor [--repo PATH | --demo] [--commit REF] [--critic ID] [--json]
  ccdd doctor --url URL --commit HASH [--critic ID] [--json]
  ccdd prepare-demo
  ccdd run --commit HASH [--critic ID] [--requester ID] [--wait] [--timeout-ms 600000]
  ccdd status RUN_ID [--wait] [--timeout-ms 600000]
  ccdd list

--critic evaluates only that Critic. Without it, run evaluates the full chain.
run/status/list return JSON. --wait returns 0=GREEN, 1=RED, 2=ERROR, 3=wait timed out.
Without --wait, run returns 0 when the broker accepts the request, not when it passes.
Doctor performs actual Provider/model/Artifact-tool probes and consumes Agent usage.
Node 24+, Git, and model access through Codex login are required for Agent reviews.`);return 0;
    }
    if(command==='serve'){
      const {manifest,repoPath}=await repoContext();
      const port=Number(get('--port',process.env.PORT||'4317'));
      if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid --port.');
      const app=await startServer({repoPath,stateDir,manifest,port,codexPath,humanInbox:Boolean(options['--human-inbox'])});
      print(`CCDD ${packageVersion} · ${app.url}`);
      let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
      process.on('SIGINT',close);process.on('SIGTERM',close);return 0;
    }
    if(command==='prepare-demo'){print(await prepareDemo());return 0;}
    if(command==='doctor'){
      const timeoutMs=timeoutValue(get('--timeout-ms'),900000),signal=AbortSignal.timeout(timeoutMs);
      const criticId=get('--critic');
      let report;
      if(options['--url']){
        const snapshotCommit=get('--commit');
        if(!snapshotCommit)throw new Error('doctor --url requires --commit with a full immutable commit hash.');
        report=await requestJson(get('--url').replace(/\/$/,'')+'/api/doctor',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({snapshotCommit,criticId}),signal});
      }else{
        const {manifest,repoPath}=await repoContext();
        const ref=get('--commit','HEAD');
        const snapshotCommit=(await git(repoPath,['rev-parse','--verify','--end-of-options',`${ref}^{commit}`],{signal})).trim();
        const executors=createExecutorRegistry({codexPath,alarmMethods:createLocalAlarmMethods({stateDir,humanInbox:Boolean(options['--human-inbox'])})});
        report=await diagnoseProject({repoPath,repoId:manifest?.repoId||'demo',snapshotCommit,criticId,executors,signal});
      }
      if(json)print(report);
      else{
        print(`CCDD doctor · ${report.status}\nSnapshot: ${report.snapshotCommit}\nScope: ${report.scope?.kind==='critic'?report.scope.criticId:'전체 프로젝트 요구사항'}`);
        for(const check of report.checks||[]){print(`[${check.status}] ${check.message}`);if(check.remedy)print(`  조치: ${check.remedy}`);}
        print('이 결과는 진단 시점의 실행 준비 상태입니다. Critic의 통과 판정은 별도 리뷰에서 결정됩니다.');
      }
      return report.ok?0:1;
    }
    if(['run','status','list'].includes(command)){
      const url=get('--url','http://127.0.0.1:4317').replace(/\/$/,'');
      if(command==='status'&&!positional[0])throw new Error('status requires a run ID.');
      if(command==='run'&&!get('--commit'))throw new Error('run requires --commit with a full immutable Git commit hash.');
      const wait=Boolean(options['--wait']);
      const timeoutMs=timeoutValue(get('--timeout-ms'));
      const body={snapshotCommit:get('--commit'),requesterId:get('--requester','cli'),criticId:get('--critic')};
      let result=command==='run'?await requestJson(url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}):await requestJson(url+(command==='list'?'/api/runs':`/api/runs/${encodeURIComponent(positional[0])}`));
      if(wait&&command!=='list'){
        stderr.write(`Review handle: ${result.id}\n`);
        const waited=await waitForRun({url,run:result,timeoutMs});result=waited.run;
        if(!waited.completed){print({...result,wait:{completed:false,reason:'timeout'}});return 3;}
        print(result);return exitForRun(result);
      }
      print(result);return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  }catch(error){
    if(options['--json'])print({error:error.message,...(error.runId?{runId:error.runId}:{})});
    else stderr.write(`${error.message}${error.runId?` (handle: ${error.runId})`:''}\n`);
    return 2;
  }
}
let entrypoint=false;
try { entrypoint=Boolean(process.argv[1])&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url); } catch {}
if(entrypoint)process.exitCode=await main();
