// Offline transport fixture: real Pi, SSE parsing, tools, Broker and requester subscription.
// BENCH_PREFIX=/external/pi60- node --cpu-prof scripts/benchmark-pi-streams.mjs 60 changes unique-label
import {network} from './offline-network-guard.mjs';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {OPENAI_CODEX_MODELS} from '../node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.models.js';
// Same catalog-only alias as the lab patch; no credential lookup or model call.
OPENAI_CODEX_MODELS['gpt-6-luna']={...OPENAI_CODEX_MODELS['gpt-6-astra'],id:'gpt-6-luna',name:'GPT-6 Luna'};
const {createBroker,brokerTestHooks}=await import('../dist/src/broker/index.js');
const {createExecutorRegistry}=await import('../dist/src/executors/index.js');
const {streamSimple}=await import('../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js');
const concurrency=Number(process.argv[2]??4), mode=process.argv[3]??'changes',label=process.argv[4]??`${mode}-${concurrency}`;
const prefix=process.env.BENCH_PREFIX; if(!prefix)throw Error('Set BENCH_PREFIX to an external path prefix whose project directory contains a copied lab fixture.');
const turns=new Map(), tools=[], errors=[],argumentBytes=[],wireBytes=[];
const token='offline.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline-fixture'}})).toString('base64url')+'.fixture';
let count=0,streams=0,hydrated=0,flushes=0,flushMs=0;brokerTestHooks.onHydrate=n=>hydrated+=n;
const fakeStream=(model,context,options)=>{
 const key=options.sessionId, turn=turns.get(key)??0;turns.set(key,turn+1);streams++;
 const target=context.tools.find(t=>t.name.startsWith('describe_')).name.slice('describe_'.length);
 const operations=['describe','tooltips','recommended_character','damage_summary'];let args={};
 if(turn===3){const seen=context.messages.find(m=>m.role==='toolResult'&&m.toolName===`recommended_character_${target}`);args=seen.content.filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text)}catch{return null}}).find(x=>x?.character);if(!args)throw Error('missing character');}
 if(turn===3){args.character.weapon.customStats=Array.from({length:70},(_,i)=>({type:'attack_power_flat',value:100+i}));}
 const text=turn<4?JSON.stringify(args):'{"verdict":"GREEN"}';argumentBytes.push(Buffer.byteLength(text));
 return streamSimple(model,context,{...options,apiKey:token,maxRetries:0,fetch:async(_url,init)=>{
  wireBytes.push(init.body.length);let stop=false;const encoder=new TextEncoder();
  const body=new ReadableStream({async start(controller){const emit=e=>{if(!stop)controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));};
   try{
    emit({type:'response.created',response:{id:`resp_${key}_${turn}`}});
    const reasoning={id:`rs_${turn}`,type:'reasoning',summary:[{type:'summary_text',text:'Inspect the scoped observations and verify the numbers.'}],encrypted_content:'x'.repeat(16384)};
    emit({type:'response.output_item.added',output_index:0,item:{id:reasoning.id,type:'reasoning',summary:[]}});
    for(let n=0;n<10;n++){await delay(Number(process.env.DELTA_MS??50));emit({type:'response.reasoning_summary_text.delta',output_index:0,delta:'Inspect scoped evidence. '});}
    emit({type:'response.output_item.done',output_index:0,item:reasoning});
    const item=turn<4?{type:'function_call',id:`fc_${turn}`,call_id:`call_${turn}`,name:`${operations[turn]}_${target}`,arguments:''}:{type:'message',id:`msg_${turn}`,role:'assistant',content:[],phase:'final_answer'};
    emit({type:'response.output_item.added',output_index:1,item});
    // 16 UTF-8-ish characters per 50ms: about 80 tokens/sec at four chars/token.
    for(let i=0;i<text.length;i+=16){await delay(Number(process.env.DELTA_MS??50));emit({type:turn<4?'response.function_call_arguments.delta':'response.output_text.delta',output_index:1,content_index:0,delta:text.slice(i,i+16)});}
    const done=turn<4?{...item,arguments:text}:{...item,content:[{type:'output_text',text}]};
    emit({type:'response.output_item.done',output_index:1,item:done});
    if(turn===0){let index=2;for(const tool of context.tools.filter(t=>t.name.startsWith('describe_')&&t.name!==item.name)){const extra={type:'function_call',id:`fc_extra_${index}`,call_id:`call_extra_${index}`,name:tool.name,arguments:'{}'};emit({type:'response.output_item.added',output_index:index,item:{...extra,arguments:''}});emit({type:'response.function_call_arguments.delta',output_index:index,delta:'{}'});emit({type:'response.output_item.done',output_index:index++,item:extra});}}
    emit({type:'response.completed',response:{id:`resp_${key}_${turn}`,status:'completed',output:[reasoning,done],usage:{input_tokens:1000,output_tokens:100,total_tokens:1100}}});
    if(!stop)controller.close();
   }catch(e){if(!stop)controller.error(e);}
  },cancel(){stop=true;}});
  return new Response(body,{headers:{'content-type':'text/event-stream'}});
 }});
};
const realExecutors=createExecutorRegistry({streamFn:fakeStream});
const broker=createBroker({repoPath:prefix+'project',stateDir:prefix+'state-'+label,workspaceIntegrity:'metadata',maxConcurrentExecutors:concurrency,identityConcurrency:8,executors:{canExecute:()=>({ok:true}),async execute(request,context){
 try{const result=await realExecutors.execute({...request,profile:{kind:'agent',provider:'openai-codex',model:'gpt-6-luna',reasoning:'xhigh',timeoutMs:720000}}, {...context,onEvent:e=>{if(e.type==='artifact.tool.completed')tools.push(e);return context.onEvent?.(e);}});count++;return result;}catch(e){errors.push({code:e.code,message:e.message});throw e;}

}}});
writeFileSync(prefix+label+'.pid',String(process.pid));let tail=Promise.resolve(),scheduled=false,unsubscribe,cursor=0;
const histogram=monitorEventLoopDelay({resolution:10});let timer;
try{const submitted=await broker.submitProject({selection:{kind:'all'},force:true});console.log(JSON.stringify({phase:'run',concurrency,mode,requests:submitted.requests.length}));
 if(mode==='subscriber'||mode==='changes')unsubscribe=broker.onChange(()=>{if(scheduled)return;scheduled=true;tail=tail.then(()=>{scheduled=false;const t=performance.now();if(mode==='changes'){let page;do{page=broker.changes(submitted.id,{after:cursor});cursor=page.cursor;}while(page.hasMore);}else broker.getRun(submitted.id);flushMs+=performance.now()-t;flushes++;});});
 hydrated=0;histogram.enable();const start=performance.now(),cpu=process.cpuUsage();timer=setInterval(()=>console.log(JSON.stringify({progress:{seconds:(performance.now()-start)/1000,count,tools:tools.length,streams,flushes,loopMax:histogram.max/1e6}})),10000);
 const result=await broker.run(submitted.id);unsubscribe?.();await tail;
 const q=(v,p)=>v.sort((a,b)=>a-b)[Math.min(v.length-1,Math.floor(v.length*p))]??0;
 const report={label,concurrency,mode,status:result.status,count,errors,streams,turns:[...new Set(turns.values())],runMs:performance.now()-start,cpu:process.cpuUsage(cpu),hydrated,flushes,flushMs,networkBlocked:network.blocked,tool:{count:tools.length,p50:q(tools.map(x=>x.durationMs),.5),p90:q(tools.map(x=>x.durationMs),.9),max:Math.max(...tools.map(x=>x.durationMs))},loop:{p50:histogram.percentile(50)/1e6,p90:histogram.percentile(90)/1e6,max:histogram.max/1e6},maxArgumentBytes:Math.max(...argumentBytes),maxWireBytes:Math.max(...wireBytes)};
 writeFileSync(prefix+label+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(result.status!=='GREEN'||count!==submitted.requests.length||errors.length||network.blocked)throw Error('Offline acceptance did not complete cleanly.');
}finally{clearInterval(timer);histogram.disable();unsubscribe?.();await broker.close();}
