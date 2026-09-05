#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareDemo} from '../scripts/prepare-demo.js';
import {packageVersion} from './runtime-paths.js';
import {createExecutorRegistry} from './executors/index.js';
import {diagnoseProject} from './doctor/index.js';
import {createBroker,readStateContext} from './broker/index.js';
import {localContext,createLocalAlarmMethods} from './local.js';
import {readArtifact} from './artifacts/index.js';
import {reopenWorkspace} from './workspaces/index.js';
import type { PiOptions } from './executors/pi.js';
import { errorMessage, errorCode } from './executors/errors.js';
import { startMonitor } from './monitor/server.js';
type Broker = ReturnType<typeof createBroker>;
type Run = NonNullable<ReturnType<Broker['getRun']>>;
export interface WorkerOptions { runId: string; repoPath: string; repoId: string; stateDir: string; piOptions?: PiOptions; humanInbox: boolean }
type Output = { write(text: string): unknown };
type Options = Record<string, string | boolean>;

const terminal=new Set(['GREEN','RED','ERROR']);
const booleanFlags=new Set(['--demo','--human-inbox','--wait','--json','--help','--lock','--copy']);
const valueFlags=new Set(['--repo','--state-dir','--pi-auth-file','--codex-auth-file','--requester','--critic','--timeout-ms','--scenario','--demo-dir','--reviewer','--result-file','--file','--start-line','--line-count','--offset','--limit','--port']);
function parse(argv: string[]){
  const options: Options={},positional: string[]=[];
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
function timeoutValue(value: string | undefined,fallback=600000){
  const ms=value===undefined?fallback:Number(value);
  if(!Number.isSafeInteger(ms)||ms<1||ms>86400000)throw new Error('--timeout-ms must be between 1 and 86400000.');
  return ms;
}
const exitForRun=(run:Run)=>run.status==='GREEN'?0:run.status==='RED'?1:2;

export async function launchWorker({runId,...context}:WorkerOptions){
  const worker=fork(fileURLToPath(new URL('./worker.js',import.meta.url)),[JSON.stringify({runId,...context})],{
    detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[],
    env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),
  });
  await new Promise<void>((ok,no)=>{
    const timer=setTimeout(()=>finish(new Error('Review worker startup timed out.')),15000);
    const finish=(error?:Error)=>{clearTimeout(timer);worker.off('error',fail);worker.off('exit',exit);worker.off('message',message);if(error){worker.kill('SIGTERM');no(error);}else ok();};
    const fail=(error:Error)=>finish(error);
    const exit=(code:number|null)=>finish(new Error(`Review worker exited during startup (${code}).`));
    const message=(value: {type:string;message:string;code?:string})=>{if(value?.type==='ready')finish();else if(value?.type==='error')finish(Object.assign(new Error(value.message),{code:value.code}));};
    worker.once('error',fail);worker.once('exit',exit);worker.on('message',message);
  });
  worker.unref();
  worker.channel?.unref();
  return worker.pid;
}

/** Waiting clients do not own execution; timeout never cancels the review worker. */
export async function waitForRun({broker,run,timeoutMs=600000,pollMs=100,signal}: {broker:Broker;run:Run;timeoutMs?:number;pollMs?:number;signal?:AbortSignal}){
  const deadline=Date.now()+timeoutMs;
  while(!terminal.has(run.status)){
    if(signal?.aborted||Date.now()>=deadline)return {run,completed:false};
    await delay(Math.min(pollMs,Math.max(1,deadline-Date.now())));
    const current=await broker.getRun(run.id);
    if(!current)throw new Error('Review handle no longer exists.');
    run=current;
  }
  return {run,completed:true};
}

export async function main(argv: string[]=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}: {stdout?:Output;stderr?:Output}={}){
  const print=(value:unknown)=>stdout.write(typeof value==='string'?value+'\n':JSON.stringify(value,null,2)+'\n');
  let options:Options={};
  let broker:Broker|undefined;
  try{
    const command=argv[0]||'help';
    const parsed=parse(argv.slice(1));options=parsed.options;
    const {positional}=parsed;
    const get=(key:string,fallback?:string):string|undefined=>typeof options[key]==='string'?options[key] as string:fallback;
    if(command==='help'||command==='--help'||options['--help']){
      print(`CCDD ${packageVersion} — critic broker & artifact runner

  ccdd run (--copy | --lock) [--repo PATH] [--critic ID] [--wait]
  ccdd doctor [--repo PATH] [--critic ID] [--copy | --lock] [--json]
  ccdd status RUN_ID [--wait]
  ccdd list
  ccdd monitor [--repo PATH | --state-dir PATH] [--port 4318]
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
No daemon, HTTP server, Git repository, or commit is required for reviews.
monitor is an optional local read-only view; it does not start or own reviews.
--critic runs only that Critic; omission evaluates the full linear chain.
Commands return JSON. --wait: 0=GREEN, 1=RED, 2=ERROR, 3=wait timed out.
Without --wait, run returns 0 for acceptance; the independent review worker continues.
--timeout-ms controls client waiting, not review execution; use cancel to stop a review.
--human-inbox explicitly registers the local inbox alarm for run/doctor.
Doctor probes actual Provider/model/Artifact tools and consumes Agent usage.
Agent reviews use Pi libraries; Provider/model/reasoning must match the Pi catalog.
--pi-auth-file PATH reads a Pi credential file; Provider API key environment variables also work.
--codex-auth-file PATH explicitly reads an unexpired Codex access token, without refreshing it.
Only credential paths are saved for worker/resume; credentials are never copied into review state.`);return 0;
    }
    if(command==='monitor'){
      const permitted=new Set(['--repo','--state-dir','--port']);
      if(positional.length||Object.keys(options).some(key=>!permitted.has(key)))throw new Error('monitor accepts only --repo, --state-dir and --port.');
      if(options['--repo']&&options['--state-dir'])throw new Error('monitor --repo and --state-dir are mutually exclusive.');
      const portValue=get('--port','4318')!;
      const port=Number(portValue);
      if(!/^\d+$/.test(portValue)||!Number.isInteger(port)||port<0||port>65535)throw new Error('--port must be an integer from 0 to 65535.');
      const stateDir=options['--repo']?(await localContext({repoPath:resolve(get('--repo')!)})).stateDir:get('--state-dir');
      const monitor=await startMonitor({...(stateDir?{stateDirs:[resolve(stateDir)]}:{}),port});
      print(`CCDD monitor · ${monitor.url}`);
      await new Promise<void>((ok,no)=>{
        let stopping=false;
        const stop=()=>{
          if(stopping)return;stopping=true;
          process.off('SIGINT',stop);process.off('SIGTERM',stop);
          void monitor.close().then(ok,no);
        };
        process.once('SIGINT',stop);process.once('SIGTERM',stop);
      });
      return 0;
    }
    if(options['--port']!==undefined)throw new Error('--port requires the monitor command.');
    if(options['--lock']&&options['--copy'])throw new Error('--lock and --copy are mutually exclusive.');
    if(command==='run'&&!options['--lock']&&!options['--copy'])throw new Error('run requires exactly one of --copy (recommended) or --lock.');
    if(command!=='artifact'&&['--start-line','--line-count','--offset','--limit'].some(key=>options[key]!==undefined))throw new Error('Artifact read/list options require the artifact command.');
    const allowed=new Set(['run','doctor','status','list','request','artifact','human-claim','human-result','resume','cancel','prepare-demo']);
    if(!allowed.has(command))throw new Error(`Unknown command: ${command}. No server is needed; use run --copy or run --lock.`);
    if(command==='prepare-demo'){print(await prepareDemo({...(get('--demo-dir')?{root:resolve(get('--demo-dir')!)}:{})}));return 0;}
    const timeoutMs=timeoutValue(get('--timeout-ms'),command==='doctor'?900000:600000);
    let repoPath=resolve(get('--repo',process.cwd())!);
    if(options['--demo']){
      if(options['--repo'])throw new Error('--demo and --repo are mutually exclusive.');
      const manifest=await prepareDemo({...(get('--demo-dir')?{root:resolve(get('--demo-dir')!)}:{})});
      const scenario=manifest.scenarios.find(s=>s.id===get('--scenario','baseline'));
      if(!scenario)throw new Error(`Unknown demo scenario: ${get('--scenario')}`);
      repoPath=scenario.repoPath;
    }else if(options['--scenario'])throw new Error('--scenario requires --demo.');
    const existingCommand=!['run','doctor'].includes(command);
    let context;
    if(existingCommand&&options['--state-dir']&&!options['--demo']){
      context=readStateContext(resolve(get('--state-dir')!));
      if(options['--repo']){
        let requested;
        try{requested=realpathSync(repoPath);}catch(error){if(errorCode(error)!=='ENOENT')throw error;requested=resolve(repoPath);}
        if(requested!==context.repoPath)throw new Error('This state directory belongs to a different repository.');
      }
    }else context=await localContext({repoPath,stateDir:get('--state-dir')});
    const piOptions:PiOptions={};
    const authFile=get('--pi-auth-file',process.env.CCDD_PI_AUTH_FILE);
    const codexAuthFile=get('--codex-auth-file',process.env.CCDD_CODEX_AUTH_FILE);
    if(authFile)piOptions.authFile=resolve(authFile);
    if(codexAuthFile)piOptions.codexAuthFile=resolve(codexAuthFile);
    const humanInbox=Boolean(options['--human-inbox']);
    const executors=createExecutorRegistry({piOptions,alarmMethods:createLocalAlarmMethods({...context,humanInbox})});
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
    const activeBroker=createBroker({...context,executors});
    broker=activeBroker;
    const needId=()=>{if(!positional[0])throw new Error(`${command} requires an ID.`);return positional[0];};
    const launch=async (run:Run):Promise<Run>=>{
      try{
        const runDir=join(context.stateDir,'runs',run.id);
        await mkdir(runDir,{recursive:true,mode:0o700});
        const configPath=join(runDir,'worker.json');
        try{await writeFile(configPath,JSON.stringify({piOptions,humanInbox}),{flag:'wx',mode:0o600});}catch(error){if(errorCode(error)!=='EEXIST')throw error;}
        const config=JSON.parse(await readFile(configPath,'utf8'));
        try{await launchWorker({...context,runId:run.id,...config});}
        catch(error){if(errorCode(error)!=='RUN_ALREADY_OWNED')throw error;}
      }catch(error){try{await activeBroker.failRun?.(run.id,error);}catch{}throw Object.assign(error instanceof Error?error:new Error(String(error)),{runId:run.id});}
      const current=activeBroker.getRun(run.id);if(!current)throw new Error('Review handle not found.');return current;
    };
    let result:Run|null;
    if(command==='run'){
      result=await activeBroker.submit({mode,requesterId:get('--requester','cli'),criticId:get('--critic')});
      stderr.write(`Review handle: ${result.id}\nState: ${context.stateDir}\n`);
      result=await launch(result);
    }else if(command==='list'){print(await activeBroker.listRuns());return 0;}
    else if(command==='status'||command==='resume'||command==='cancel'){
      const id=needId();result=await activeBroker.getRun(id);if(!result)throw new Error('Review handle not found.');
      if(command==='resume'&&!terminal.has(result.status))result=await launch(result);
      if(command==='cancel')result=await activeBroker.cancel(id);
    }else{
      const request=await activeBroker.getRequest(needId());if(!request)throw new Error('Review request not found.');
      if(command==='request'){print(request);return 0;}
      if(command==='artifact'){
        if(!positional[1])throw new Error('artifact requires an Artifact ID.');
        const paging:Record<string,number>={};
        for(const [flag,key,min,max] of [['--start-line','startLine',1,Number.MAX_SAFE_INTEGER],['--line-count','lineCount',1,500],['--offset','offset',0,Number.MAX_SAFE_INTEGER],['--limit','limit',1,200]] as const){
          if(options[flag]!==undefined){
            const value=Number(options[flag]);
            if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
            paging[key]=value;
          }
        }
        const handle=await reopenWorkspace(request.workspace);
        try{
          const artifact=await readArtifact({worktreePath:handle.descriptor.path,artifacts:request.artifacts,artifactTypes:request.artifactTypes,artifactId:positional[1],...(options['--file']?{file:get('--file')!}:{}),...paging});
          await handle.assertUnchanged();print({...artifact,snapshotHash:request.snapshotHash});
        }finally{await handle.close();}
        return 0;
      }
      const reviewerId=get('--reviewer');if(!reviewerId)throw new Error(`${command} requires --reviewer.`);
      if(command==='human-claim'){print(await activeBroker.claimHuman(request.id,reviewerId));return 0;}
      const resultFile=get('--result-file');if(!resultFile)throw new Error('human-result requires --result-file containing {verdict,summary,evidence}.');
      const content=await readFile(resolve(resultFile),'utf8');if(Buffer.byteLength(content)>256000)throw new Error('Human result file is too large.');
      await activeBroker.completeHuman(request.id,{reviewerId,result:JSON.parse(content)});
      result=await activeBroker.getRun(request.runId);
      if(!result)throw new Error('Review handle not found.');
      if(result.status==='QUEUED')result=await launch(result);
    }
    if(!result)throw new Error('Review handle not found.');
    if(options['--wait']){
      const waited=await waitForRun({broker,run:result,timeoutMs});
      if(!waited.completed){print({...waited.run,wait:{completed:false,reason:'timeout'}});return 3;}
      print(waited.run);return exitForRun(waited.run);
    }
    print(result);return 0;
  }catch(caught){
    const error=Object.assign(new Error(errorMessage(caught)),{code:errorCode(caught),runId:(caught as {runId?:string})?.runId});
    if(options['--json']||argv.includes('--json'))print({error:error.message,...(error.code?{code:error.code}:{}),...(error.runId?{runId:error.runId}:{})});
    else stderr.write(`${error.message}${error.runId?` (handle: ${error.runId})`:''}\n`);
    return 2;
  }finally{await broker?.close();}
}
let entrypoint=false;
try{entrypoint=Boolean(process.argv[1])&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url);}catch{}
if(entrypoint)process.exitCode=await main();
