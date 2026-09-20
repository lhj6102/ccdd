import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

// Offline tool-path benchmark. No Provider, Broker execution or review verdicts.
const {values}=parseArgs({options:{implementation:{type:'string',default:'dist'},output:{type:'string'},samples:{type:'string',default:'200'}}});
const samples=Number(values.samples);
if(!Number.isSafeInteger(samples)||samples<1)throw new Error('samples must be a positive integer');
const dist=resolve(values.implementation), root=await mkdtemp(join(tmpdir(),'ccdd-generated-tool-benchmark-'));
const wire={};
let captureWire=true;
const fork=childProcess.fork;
childProcess.fork=function(...args){
  const child=fork.apply(this,args),send=child.send;
  child.send=function(message,...rest){
    if(captureWire){
      const action=message.action??'other';
      const row=wire[action]??={calls:0,bytes:0};row.calls++;row.bytes+=Buffer.byteLength(JSON.stringify(message));
    }
    return send.call(this,message,...rest);
  };
  return child;
};
syncBuiltinESMExports();
const {inspectProject}=await import(pathToFileURL(join(dist,'src/project/index.js')));
const {createReviewTools}=await import(pathToFileURL(join(dist,'src/tools/runner.js')));
const {resolveArtifactScope}=await import(pathToFileURL(join(dist,'src/artifacts/groups.js')));
const median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
const results=[];
try{
  for(const count of [100,500]){
    const repoPath=join(root,String(count));await mkdir(repoPath);
    const data={rows:Array.from({length:count},(_,i)=>({id:i,type:'hit',time:100,level:10,value:123.45,enabled:true,children:[{id:i,value:5},{id:i+1,value:10}]}))};
    await writeFile(join(repoPath,'data.json'),JSON.stringify(data));
    await writeFile(join(repoPath,'ccdd.config.ts'),`
import {readFile} from 'node:fs/promises';
const source={metadata:{preparation:'read-only',identity:{kind:'canonical-data',namespace:'benchmark',version:'1'}},async prepare(context){return {data:JSON.parse(await readFile(await context.resolvePath('data.json'),'utf8'))}}};
const metadata={description:'Return a constant for {artifactName}.',inputSchema:{type:'object',properties:{},additionalProperties:false},resultKinds:['json'],observation:'content',artifactKind:'data'};
const result=()=>({content:[{type:'json',data:{ok:true}}],observation:{kind:'content'}});
const noop={metadata,execute(){return result()}};
const read={metadata,execute(context){context.readData();return result()}};
export default {artifactSources:{fixture:source},artifactTypes:{fixture:{agentTools:{noop,read}}},artifacts:{Fixture:{kind:'generated',type:'fixture',source:'fixture'}},critics:[{id:'evaluate',title:'Benchmark',payload:{instruction:'Offline tool benchmark.'},target:'Fixture',deps:[],profile:{kind:'agent',provider:'openai-codex',model:'gpt-6-astra',reasoning:'medium'}}]};
`);
    let start=performance.now();
    const {snapshot:{config}}=await inspectProject({repoPath,stateDir:join(root,'inspect-'+count),workspaceIntegrity:'content'});
    const inspectMs=performance.now()-start;
    for(const key of Object.keys(wire))delete wire[key];
    start=performance.now();
    const registry=await createReviewTools({worktreePath:repoPath,...resolveArtifactScope(config.artifacts,['Fixture'],config.artifactInputs),artifactTypes:config.artifactTypes,configManifest:config.configManifest,criticId:'evaluate',audience:'agent',runDir:join(root,'tools-'+count)});
    const setupMs=performance.now()-start,setupWire=structuredClone(wire),times={noop:[],read:[]};
    for(const key of Object.keys(wire))delete wire[key];
    captureWire=false;
    try{
      for(let i=0;i<samples+20;i++)for(const operation of ['noop','read']){
        start=performance.now();const result=await registry.call(operation+'_Fixture',{});
        if(result.content[0]?.data?.ok!==true)throw new Error('Unexpected observation');
        if(i>=20)times[operation].push(performance.now()-start);
      }
      // Measure transport separately: instrumentation must not add JSON encoding to timed calls.
      captureWire=true;
      for(let i=0;i<10;i++)for(const operation of ['noop','read'])await registry.call(operation+'_Fixture',{});
    }finally{captureWire=true;await registry.close();}
    results.push({bytes:Buffer.byteLength(JSON.stringify(data)),inspectMs,setupMs,setupWire,callWire:structuredClone(wire),warmup:20,samplesPerTool:samples,noopMedianMs:median(times.noop),readMedianMs:median(times.read),times});
  }
  const output={implementation:dist,node:process.version,platform:process.platform,arch:process.arch,integrity:'content',modelCalls:0,workspaceCopy:false,results};
  if(values.output)await writeFile(values.output,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({...output,results:results.map(({times,...row})=>row)},null,2));
}finally{childProcess.fork=fork;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
