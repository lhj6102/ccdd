#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareDemo} from '../scripts/prepare-demo.mjs';
import {bundledCodexPath,packageVersion} from './runtime-paths.mjs';
import {createExecutorRegistry} from './executors/index.mjs';
import {diagnoseProject} from './doctor/index.mjs';
import {createBroker,readStateContext} from './broker/index.mjs';
import {localContext,createLocalAlarmMethods} from './local.mjs';
import {readArtifact} from './artifacts/index.mjs';
import {reopenWorkspace} from './workspaces/index.mjs';

const terminal=new Set(['GREEN','RED','ERROR']);
const booleanFlags=new Set(['--demo','--human-inbox','--wait','--json','--help','--lock','--copy']);
const valueFlags=new Set(['--repo','--state-dir','--codex','--requester','--critic','--timeout-ms','--scenario','--demo-dir','--reviewer','--result-file','--file','--start-line','--line-count','--offset','--limit']);
function parse(argv){
  const options={},positional=[];
  for(let i=0;i<argv.length;i++){
    const item=argv[i];
    if(booleanFlags.has(item)||valueFlags.has(item)){
      if(options[item]!==undefined)throw new Error(`Duplicate option: ${item}`);
      if(booleanFlags.has(item)){options[item]=true;continue;}
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

export async function launchWorker({runId,...context}){
  const worker=fork(fileURLToPath(new URL('./worker.mjs',import.meta.url)),[JSON.stringify({runId,...context})],{
    detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[],
    env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),
  });
  await new Promise((ok,no)=>{
    const timer=setTimeout(()=>finish(new Error('Review worker startup timed out.')),15000);
    const finish=error=>{clearTimeout(timer);worker.off('error',fail);worker.off('exit',exit);worker.off('message',message);if(error){worker.kill('SIGTERM');no(error);}else ok();};
    const fail=error=>finish(error);
    const exit=code=>finish(new Error(`Review worker exited during startup (${code}).`));
    const message=value=>{if(value?.type==='ready')finish();else if(value?.type==='error')finish(Object.assign(new Error(value.message),{code:value.code}));};
    worker.once('error',fail);worker.once('exit',exit);worker.on('message',message);
  });
  worker.unref();
  worker.channel?.unref();
  return worker.pid;
}

/** Waiting clients do not own execution; timeout never cancels the review worker. */
export async function waitForRun({broker,run,timeoutMs=600000,pollMs=100,signal}){
  const deadline=Date.now()+timeoutMs;
  while(!terminal.has(run.status)){
    if(signal?.aborted||Date.now()>=deadline)return {run,completed:false};
    await delay(Math.min(pollMs,Math.max(1,deadline-Date.now())));
    run=await broker.getRun(run.id);
    if(!run)throw new Error('Review handle no longer exists.');
  }
  return {run,completed:true};
}

export async function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  const print=value=>stdout.write(typeof value==='string'?value+'\n':JSON.stringify(value,null,2)+'\n');
  let options={},broker;
  try{
    const command=argv[0]||'help';
    const parsed=parse(argv.slice(1));options=parsed.options;
    const {positional}=parsed;
    const get=(key,fallback)=>options[key]??fallback;
    if(command==='help'||command==='--help'||options['--help']){
      print(`CCDD ${packageVersion} — critic broker & artifact runner

  ccdd run (--copy | --lock) [--repo PATH] [--critic ID] [--wait]
  ccdd doctor [--repo PATH] [--critic ID] [--copy | --lock] [--json]
  ccdd status RUN_ID [--wait]
  ccdd list
  ccdd request REQUEST_ID
  ccdd artifact REQUEST_ID ARTIFACT_ID [--file RELATIVE_PATH] [--start-line 1] [--line-count 80]
  ccdd human-claim REQUEST_ID --reviewer ID
  ccdd human-result REQUEST_ID --reviewer ID --result-file PATH
  ccdd resume RUN_ID [--wait]
  ccdd cancel RUN_ID
  ccdd prepare-demo [--demo-dir PATH]
  ccdd run --demo [--scenario baseline|why-change|runtime-failure|fixed] --copy --wait

All review commands accept --repo PATH and --state-dir PATH (outside the repo).
run requires exactly one workspace mode. --copy is recommended; doctor defaults to copy.
No daemon, HTTP server, Git repository, or commit is required.
--critic runs only that Critic; omission evaluates the full linear chain.
Commands return JSON. --wait: 0=GREEN, 1=RED, 2=ERROR, 3=wait timed out.
Without --wait, run returns 0 for acceptance; the independent review worker continues.
--timeout-ms controls client waiting, not review execution; use cancel to stop a review.
--human-inbox explicitly registers the local inbox alarm for run/doctor.
Doctor probes actual Provider/model/Artifact tools and consumes Agent usage.
Agent reviews require Node 24+ and model access through Codex login.`);return 0;
    }
    if(options['--lock']&&options['--copy'])throw new Error('--lock and --copy are mutually exclusive.');
    if(command==='run'&&!options['--lock']&&!options['--copy'])throw new Error('run requires exactly one of --copy (recommended) or --lock.');
    if(command!=='artifact'&&['--start-line','--line-count','--offset','--limit'].some(key=>options[key]!==undefined))throw new Error('Artifact read/list options require the artifact command.');
    const allowed=new Set(['run','doctor','status','list','request','artifact','human-claim','human-result','resume','cancel','prepare-demo']);
    if(!allowed.has(command))throw new Error(`Unknown command: ${command}. No server is needed; use run --copy or run --lock.`);
    if(command==='prepare-demo'){print(await prepareDemo({...(get('--demo-dir')?{root:resolve(get('--demo-dir'))}:{})}));return 0;}
    const timeoutMs=timeoutValue(get('--timeout-ms'),command==='doctor'?900000:600000);
    let repoPath=resolve(get('--repo',process.cwd()));
    if(options['--demo']){
      if(options['--repo'])throw new Error('--demo and --repo are mutually exclusive.');
      const manifest=await prepareDemo({...(get('--demo-dir')?{root:resolve(get('--demo-dir'))}:{})});
      const scenario=manifest.scenarios.find(s=>s.id===get('--scenario','baseline'));
      if(!scenario)throw new Error(`Unknown demo scenario: ${get('--scenario')}`);
      repoPath=scenario.repoPath;
    }else if(options['--scenario'])throw new Error('--scenario requires --demo.');
    const existingCommand=!['run','doctor'].includes(command);
    let context;
    if(existingCommand&&options['--state-dir']&&!options['--demo']){
      context=readStateContext(resolve(get('--state-dir')));
      if(options['--repo']){
        let requested;
        try{requested=realpathSync(repoPath);}catch(error){if(error.code!=='ENOENT')throw error;requested=resolve(repoPath);}
        if(requested!==context.repoPath)throw new Error('This state directory belongs to a different repository.');
      }
    }else context=await localContext({repoPath,stateDir:get('--state-dir')});
    const codexPath=get('--codex',process.env.CCDD_CODEX_PATH||bundledCodexPath);
    const humanInbox=Boolean(options['--human-inbox']);
    const executors=createExecutorRegistry({codexPath,alarmMethods:createLocalAlarmMethods({...context,humanInbox})});
    const mode=options['--lock']?'lock':'copy';
    if(command==='doctor'){
      const report=await diagnoseProject({...context,mode,criticId:get('--critic'),executors,signal:AbortSignal.timeout(timeoutMs)});
      if(options['--json'])print(report);
      else{
        print(`CCDD doctor · ${report.status}\nSnapshot: ${report.snapshotHash ?? '(unavailable)'}\nScope: ${report.scope?.kind==='critic'?report.scope.criticId:'전체 프로젝트 요구사항'}`);
        for(const check of report.checks||[]){print(`[${check.status}] ${check.message}`);if(check.remedy)print(`  조치: ${check.remedy}`);}
      }
      return report.ok?0:1;
    }
    broker=await createBroker({...context,executors});
    const needId=()=>{if(!positional[0])throw new Error(`${command} requires an ID.`);return positional[0];};
    const launch=async run=>{
      try{
        const runDir=join(context.stateDir,'runs',run.id);
        await mkdir(runDir,{recursive:true,mode:0o700});
        const configPath=join(runDir,'worker.json');
        try{await writeFile(configPath,JSON.stringify({codexPath,humanInbox}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
        const config=JSON.parse(await readFile(configPath,'utf8'));
        try{await launchWorker({...context,runId:run.id,...config});}
        catch(error){if(error.code!=='RUN_ALREADY_OWNED')throw error;}
      }catch(error){try{await broker.failRun?.(run.id,error);}catch{}error.runId=run.id;throw error;}
      return await broker.getRun(run.id);
    };
    let result;
    if(command==='run'){
      result=await broker.submit({mode,requesterId:get('--requester','cli'),criticId:get('--critic')});
      stderr.write(`Review handle: ${result.id}\nState: ${context.stateDir}\n`);
      result=await launch(result);
    }else if(command==='list'){print(await broker.listRuns());return 0;}
    else if(command==='status'||command==='resume'||command==='cancel'){
      const id=needId();result=await broker.getRun(id);if(!result)throw new Error('Review handle not found.');
      if(command==='resume'&&!terminal.has(result.status))result=await launch(result);
      if(command==='cancel')result=await broker.cancel(id);
    }else{
      const request=await broker.getRequest(needId());if(!request)throw new Error('Review request not found.');
      if(command==='request'){print(request);return 0;}
      if(command==='artifact'){
        if(!positional[1])throw new Error('artifact requires an Artifact ID.');
        const paging={};
        for(const [flag,key,min,max] of [['--start-line','startLine',1,Number.MAX_SAFE_INTEGER],['--line-count','lineCount',1,500],['--offset','offset',0,Number.MAX_SAFE_INTEGER],['--limit','limit',1,200]]){
          if(options[flag]!==undefined){
            const value=Number(options[flag]);
            if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
            paging[key]=value;
          }
        }
        const handle=await reopenWorkspace(request.workspace);
        try{
          const artifact=await readArtifact({worktreePath:handle.descriptor.path,artifacts:request.artifacts,artifactTypes:request.artifactTypes,artifactId:positional[1],...(options['--file']?{file:options['--file']}:{}),...paging});
          await handle.assertUnchanged();print({...artifact,snapshotHash:request.snapshotHash});
        }finally{await handle.close();}
        return 0;
      }
      const reviewerId=get('--reviewer');if(!reviewerId)throw new Error(`${command} requires --reviewer.`);
      if(command==='human-claim'){print(await broker.claimHuman(request.id,reviewerId));return 0;}
      const resultFile=get('--result-file');if(!resultFile)throw new Error('human-result requires --result-file containing {verdict,summary,evidence}.');
      const content=await readFile(resolve(resultFile),'utf8');if(Buffer.byteLength(content)>256000)throw new Error('Human result file is too large.');
      await broker.completeHuman(request.id,{reviewerId,result:JSON.parse(content)});
      result=await broker.getRun(request.runId);
      if(result.status==='QUEUED')result=await launch(result);
    }
    if(options['--wait']){
      const waited=await waitForRun({broker,run:result,timeoutMs});
      if(!waited.completed){print({...waited.run,wait:{completed:false,reason:'timeout'}});return 3;}
      print(waited.run);return exitForRun(waited.run);
    }
    print(result);return 0;
  }catch(error){
    if(options['--json']||argv.includes('--json'))print({error:error.message,...(error.code?{code:error.code}:{}),...(error.runId?{runId:error.runId}:{})});
    else stderr.write(`${error.message}${error.runId?` (handle: ${error.runId})`:''}\n`);
    return 2;
  }finally{await broker?.close();}
}
let entrypoint=false;
try{entrypoint=Boolean(process.argv[1])&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{}
if(entrypoint)process.exitCode=await main();
