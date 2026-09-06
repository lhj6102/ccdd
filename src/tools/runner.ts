import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createArtifactViewer, createAuditedArtifactTools, type ArtifactReference } from '../artifacts/index.js';
import { createHumanArtifactTools } from '../artifacts/human.js';
import type { ReviewToolCall } from '../contracts.js';
import type { ConfigManifest, JsonSchema, ToolMetadata, ToolResult } from './contracts.js';
import { metadata, object, jsonCopy, validateArguments } from './schema.js';
import { openToolHost } from './host.js';
import { scopedPath, within } from './paths.js';

export interface ReviewToolDefinition {
  artifactId: string;
  operation: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  metadata?: ToolMetadata;
  annotations?: Record<string,boolean>;
}
export interface ReviewToolCheck { toolName: string; artifactId: string; ok: boolean; message: string }
export interface ReviewToolRegistry {
  tools: ReviewToolDefinition[];
  toolCalls: ReviewToolCall[];
  validateArguments(name:string,args:unknown):Record<string,unknown>;
  call(name:string,args?:unknown):Promise<any>;
  preflight(options?:{toolName?:string}):Promise<ReviewToolCheck[]>;
  close():Promise<void>;
}
export interface ReviewToolsOptions {
  worktreePath:string; artifacts:readonly ArtifactReference[]; artifactTypes?:Readonly<Record<string,unknown>>;
  configManifest?:ConfigManifest; audience:'agent'|'human'; runDir?:string; signal?:AbortSignal;
  criticId?: string;
  onCall?:(call:ReviewToolCall)=>void|Promise<void>;
}
export function describeReviewTools({artifacts,configManifest,audience}:{artifacts:readonly ArtifactReference[];configManifest:ConfigManifest;audience:'agent'|'human'}):ReviewToolDefinition[] {
  if (configManifest.version!==1||!/^[a-f0-9]{64}$/.test(configManifest.configHash)) throw new Error('Unsupported stored tool manifest.');
  const tools:ReviewToolDefinition[]=[],names=new Set<string>();
  for(const artifact of artifacts){
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(artifact.id))throw new Error('Invalid Artifact identifier.');
    const registered=configManifest.types[artifact.type]?.[audience==='agent'?'agentTools':'humanTools'];
    if(!registered)throw new Error('Artifact type is absent from the stored manifest.');
    for(const [key,value] of Object.entries(registered)){
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key))throw new Error('Invalid tool identifier.');
      const meta=metadata(value),name=`${key}_${artifact.id}`;
      if(names.has(name))throw new Error('Artifact tool names collide.');names.add(name);
      tools.push({name,artifactId:artifact.id,operation:key,description:meta.description.replaceAll('{artifactName}',()=>artifact.id),inputSchema:meta.inputSchema,metadata:meta,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}});
    }
  }
  return tools;
}

async function normalizeResult(value:unknown,meta:ToolMetadata,outputDir:string):Promise<ToolResult>{
  if(!object(value)||Object.keys(value).some(key=>!['content','observation'].includes(key))||!Array.isArray(value.content)||!value.content.length||value.content.length>32)throw new Error('Tool result must contain bounded content blocks.');
  const result:ToolResult={content:[]};
  for(const block of value.content){
    if(!object(block)||!meta.resultKinds.includes(block.type))throw new Error('Tool returned an undeclared content kind.');
    if(block.type==='text'){
      if(typeof block.text!=='string'||Buffer.byteLength(block.text)>65536)throw new Error('Tool text exceeds 64 KiB.');
      result.content.push({type:'text',text:block.text});
    }else if(block.type==='json'){
      const data=jsonCopy(block.data);if(Buffer.byteLength(JSON.stringify(data))>524288)throw new Error('Tool JSON content exceeds 512 KiB.');
      result.content.push({type:'json',data});
    }else if(block.type==='launch'){
      if(block.launched!==true)throw new Error('Invalid launcher result.');result.content.push({type:'launch',launched:true});
    }else if(block.type==='image'){
      if(!['image/png','image/jpeg','image/webp'].includes(block.mimeType))throw new Error('Unsupported image MIME type.');
      let bytes:Buffer;
      if(typeof block.path==='string'){
        const imageRoot=await realpath(outputDir),candidate=resolve(outputDir,block.path);
        if(!within(imageRoot,candidate))throw new Error('Image is outside the tool output directory.');
        const path=await scopedPath(imageRoot,candidate.slice(imageRoot.length+1));
        const info=await lstat(path);if(!info.isFile()||info.size>4*1024*1024)throw new Error('Image exceeds 4 MiB or is not a file.');
        bytes=await readFile(path);
      }else if(typeof block.data==='string'&&block.data.length<=5600000&&/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))bytes=Buffer.from(block.data,'base64');
      else throw new Error('Image requires an output path or bounded base64 data.');
      if(!bytes.length||bytes.length>4*1024*1024)throw new Error('Invalid image size.');
      const valid=block.mimeType==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):block.mimeType==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
      if(!valid)throw new Error('Image bytes do not match declared MIME type.');
      result.content.push({type:'image',data:bytes.toString('base64'),mimeType:block.mimeType});
    }
  }
  if(value.observation!==undefined){
    if(meta.observation!=='content'||!object(value.observation)||!['content','empty'].includes(value.observation.kind)||Object.keys(value.observation).some(key=>!['kind','detail'].includes(key))||value.observation.detail!==undefined&&(typeof value.observation.detail!=='string'||value.observation.detail.length>2000))throw new Error('Invalid content observation.');
    const observed=result.content.some(block=>block.type==='image'||block.type==='json'||block.type==='text'&&(block.text.length>0||value.observation.kind==='empty'));
    if(!observed)throw new Error('Launching a program alone is not a content observation.');
    result.observation={kind:value.observation.kind,...(value.observation.detail===undefined?{}:{detail:value.observation.detail})};
  }
  return result;
}

export async function toToolContent(result:unknown):Promise<Array<{type:'text';text:string}|{type:'image';data:string;mimeType:string}>>{
  if(!object(result)||!Array.isArray(result.content))return [{type:'text',text:JSON.stringify(result)}];
  return result.content.map((block:any)=>{
    if(block.type==='image'&&typeof block.data==='string')return {type:'image' as const,data:block.data,mimeType:block.mimeType};
    return {type:'text' as const,text:block.type==='text'?block.text:JSON.stringify(block.type==='json'?block.data:{kind:'launch',launched:block.launched})};
  });
}

export async function createReviewTools(options:ReviewToolsOptions):Promise<ReviewToolRegistry>{
  const {worktreePath,artifacts,artifactTypes,configManifest,audience,signal,onCall}=options;
  if(!configManifest){
    const viewer=await createArtifactViewer({worktreePath,artifacts,artifactTypes,signal});
    if(audience==='human'){
      const old=await createHumanArtifactTools({worktreePath,artifacts,artifactTypes,signal,allowLegacy:true});
      return {...old,tools:old.tools,toolCalls:[],close:async()=>{}};
    }
    const old=createAuditedArtifactTools(viewer,{onCall});
    return {...old,tools:old.tools.map(tool=>({...tool,artifactId:tool.artifactId!,operation:tool.operation!})),get toolCalls(){return old.toolCalls;},preflight:async({toolName}={})=>Promise.all(old.tools.filter(tool=>!toolName||tool.name===toolName).map(async tool=>{
      try{await access((await viewer.resolveTarget(tool.artifactId!)).absolutePath,constants.R_OK);return {toolName:tool.name,artifactId:tool.artifactId!,ok:true,message:'Registered Viewer and Artifact are available; tool not executed.'};}
      catch{return {toolName:tool.name,artifactId:tool.artifactId!,ok:false,message:'Artifact is unavailable.'};}
    })),close:async()=>{}};
  }
  let tools:ReviewToolDefinition[];
  try { tools=describeReviewTools({artifacts,configManifest,audience}); }
  catch(error) { throw Object.assign(new Error('Recorded tool descriptors are invalid.',{cause:error}),{code:'WORKSPACE_ARTIFACT_MISMATCH'}); }
  const toolCalls:ReviewToolCall[]=[];
  const root=await realpath(worktreePath);
  const host=await openToolHost(root,signal);
  try{
    if(!isDeepStrictEqual(host.config.configManifest,configManifest)||!isDeepStrictEqual(host.config.artifactTypes,artifactTypes))throw Object.assign(new Error('Recorded tool manifest does not match this snapshot configuration.'),{code:'WORKSPACE_ARTIFACT_MISMATCH'});
    if(options.criticId!==undefined){
      const critic=host.config.critics.find(value=>value.id===options.criticId);
      if(!critic||critic.profile.kind!==audience||!isDeepStrictEqual([critic.target,...critic.deps],artifacts.map(artifact=>artifact.id)))throw Object.assign(new Error('Recorded Artifact scope does not match its Critic in the snapshot.'),{code:'WORKSPACE_ARTIFACT_MISMATCH'});
    }
    for(const artifact of artifacts){const saved=host.config.artifacts[artifact.id];if(!saved||saved.path!==artifact.path||saved.type!==artifact.type)throw Object.assign(new Error('Recorded Artifact does not match its snapshot.'),{code:'WORKSPACE_ARTIFACT_MISMATCH'});}
    const base=options.runDir?resolve(options.runDir):await mkdtemp(join(tmpdir(),'ccdd-tools-'));
    await mkdir(base,{recursive:true});const actualBase=await realpath(base);if(within(root,actualBase))throw new Error('Tool output must be outside reviewed input.');
    const outputDir=await mkdtemp(join(actualBase,'tool-output-')),temporary=join(outputDir,'.tmp');
    const find=(name:string)=>{const tool=tools.find(value=>value.name===name);if(!tool)throw new Error('Unknown registered Artifact tool.');return tool;};
    const args=(name:string,value:unknown)=>validateArguments(find(name).inputSchema,value);
    const invoke=async(action:string,tool:ReviewToolDefinition,arguments_:unknown)=>{
      signal?.throwIfAborted();
      const artifact=artifacts.find(value=>value.id===tool.artifactId)!;
      const path=await scopedPath(root,artifact.path),info=await lstat(path),shape=tool.metadata?.artifactKind;
      if(shape==='file'&&!info.isFile()||shape==='directory'&&!info.isDirectory())throw new Error('Tool does not support this Artifact shape.');
      return host.call({action,artifact,type:artifact.type,audience,toolKey:tool.operation,args:arguments_,outputDir,tmpDir:temporary},action==='preflight'?10000:tool.metadata?.timeoutMs??120000);
    };
    return {tools,toolCalls,validateArguments:args,close:host.close,
      async call(name,value={}){
        const tool=find(name),actual=args(name,value);
        const result=await normalizeResult(await invoke('execute',tool,actual),tool.metadata!,outputDir);signal?.throwIfAborted();
        const call:ReviewToolCall={name,arguments:actual,at:new Date().toISOString(),observation:{artifactId:tool.artifactId,operation:tool.operation,...result.observation}};
        await onCall?.(structuredClone(call));toolCalls.push(structuredClone(call));return result;
      },
      async preflight({toolName}={}){
        const checks:ReviewToolCheck[]=[];
        for(const tool of tools.filter(tool=>!toolName||tool.name===toolName)){
          try{const value=await invoke('preflight',tool,{});if(!object(value)||typeof value.ok!=='boolean'||typeof value.message!=='string')throw new Error('Invalid preflight result.');checks.push({toolName:tool.name,artifactId:tool.artifactId,ok:value.ok,message:value.message.slice(0,2000)});}
          catch(error){checks.push({toolName:tool.name,artifactId:tool.artifactId,ok:false,message:error instanceof Error?error.message:'Tool preparation failed.'});}
        }return checks;
      },
    };
  }catch(error){await host.close();throw error;}
}
