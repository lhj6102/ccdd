import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { mkdir, lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { metadata, jsonCopy, object, validateArguments, environmentRequirements } from './schema.js';
import { hashExecutionInputs, resolveExecutionInput } from './inputs.js';
import { scopedPath, within } from './paths.js';
import type { Config, ConfigManifest, ToolDefinition, ToolContext } from './contracts.js';

const identifier=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const registry=new Map<string,ToolDefinition<any>>();
let root='', loaded: {config: Record<string,unknown>} | undefined;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
async function load(workspace: string) {
  if (loaded) return loaded;
  root=realpathSync(workspace);
  const modules=new Map<string,string>();
  const hooks=registerHooks({
    resolve(specifier,context,next){
      let result;
      try { result=next(specifier,context); }
      catch(error){
        if (specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.startsWith('file:')) result=next(specifier.slice(0,-3)+'.ts',context);
        else throw error;
      }
      if (result.url.startsWith('file:')) {
        const absolute=realpathSync(fileURLToPath(result.url));
        if (!within(root,absolute)) throw new Error('Configuration imports must resolve inside the snapshot. Install dependencies in the reviewed project.');
        modules.set(relative(root,absolute).split('\\').join('/'),hash(readFileSync(absolute)));
      } else if (!result.url.startsWith('node:')) throw new Error('Only snapshot files and Node builtins may be imported.');
      return result;
    },
  });
  const path=join(root,'ccdd.config.ts');
  if (!existsSync(path)) throw new Error('Missing ccdd.config.ts');
  const imported=await import(pathToFileURL(path).href);
  const config:Config=typeof imported.default==='function'?await imported.default():imported.default;
  if (!object(config)||!object(config.artifactTypes)) throw new Error('TS config must export a configuration or factory.');
  const types:ConfigManifest['types']={};
  for (const [type,definition] of Object.entries(config.artifactTypes)) {
    if (!identifier.test(type)||!object(definition)||Object.keys(definition).some(key=>!['agentTools','humanTools'].includes(key))) throw new Error('TS Artifact types declare only agentTools and humanTools.');
    types[type]={agentTools:{},humanTools:{}};
    for (const audience of ['agentTools','humanTools'] as const) {
      const tools=definition[audience]??{};
      if (!object(tools)||Object.keys(tools).length>32) throw new Error('Invalid Artifact tool map.');
      for (const [key,tool] of Object.entries(tools)) {
        if (!identifier.test(key)||!object(tool)||typeof tool.execute!=='function'||(tool.preflight!==undefined&&typeof tool.preflight!=='function')||Object.keys(tool).some(key=>!['metadata','execute','preflight'].includes(key))) throw new Error(`Invalid tool definition: ${type}.${key}`);
        types[type][audience][key]=metadata(tool.metadata);
        registry.set(`${type}/${audience}/${key}`,tool as ToolDefinition<any>);
      }
    }
  }
  const values=jsonCopy({artifacts:config.artifacts,critics:config.critics});
  const envRequirements=config.envRequirements===undefined?undefined:environmentRequirements(config.envRequirements);
  const environmentInputs=envRequirements===undefined?undefined:await hashExecutionInputs(root,Object.values(envRequirements).flatMap(value=>[value.script,...value.inputs??[]]));
  if (envRequirements) for (const value of Object.values(envRequirements)) if (!(await lstat(await scopedPath(root,value.script))).isFile()) throw new Error('Environment scripts must be regular files.');
  const executionPaths=Object.values(types).flatMap(type=>[...Object.values(type.agentTools),...Object.values(type.humanTools)].flatMap(tool=>tool.executionPaths??[]));
  const executionInputs=executionPaths.length?await hashExecutionInputs(root,executionPaths):undefined;
  const extensions={...(envRequirements===undefined?{}:{envRequirements,environmentInputs}),...(executionInputs===undefined?{}:{executionInputs})};
  const moduleList=[...modules].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,hash])=>({path,hash}));
  const manifest:ConfigManifest={version:1,configHash:hash(JSON.stringify({values,types,modules:moduleList,...extensions})),modules:moduleList,types,...extensions};
  loaded={config:{...values,artifactTypes:Object.fromEntries(Object.keys(types).map(type=>[type,{custom:true}])),configManifest:manifest}};
  // Keep hooks installed throughout execution so deferred imports cannot escape the snapshot.
  void hooks;
  return loaded;
}

process.on('message',async (message:any)=>{
  const {id,action}=message;
  try {
    if (action==='load') { process.send?.({id,value:await load(message.root)}); return; }
    if (!loaded) throw new Error('Configuration is not loaded.');
    const {artifact,type,audience,toolKey,args,outputDir,tmpDir}=message;
    // Human environment requirements inspect these same reviewer-local values. Set them
    // only after snapshot configuration has loaded in its existing restricted environment.
    if (audience==='human'&&object(message.reviewerEnvironment)) for (const name of ['HOME','USERPROFILE','CARGO_HOME','RUSTUP_HOME','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) {
      const value=message.reviewerEnvironment[name];
      if (typeof value==='string') process.env[name]=value;
      else delete process.env[name];
    }
    const definition=registry.get(`${type}/${audience==='agent'?'agentTools':'humanTools'}/${toolKey}`);
    if (!definition) throw new Error('Unknown tool.');
    const declaredMetadata=(loaded.config.configManifest as ConfigManifest).types[type][audience==='agent'?'agentTools':'humanTools'][toolKey];
    const artifactPath=await scopedPath(root,artifact.path);
    const info=await lstat(artifactPath);
    if (!info.isFile()&&!info.isDirectory()) throw new Error('Artifact requires a regular file or directory.');
    if (definition.metadata.artifactKind==='file'&&!info.isFile()||definition.metadata.artifactKind==='directory'&&!info.isDirectory()) throw new Error('Tool does not support this Artifact shape.');
    const controller=new AbortController();
    const abort=()=>controller.abort(new Error('Tool host interrupted.'));
    process.once('SIGTERM',abort);
    await mkdir(outputDir,{recursive:true}); await mkdir(tmpDir,{recursive:true});
    const context:ToolContext={artifactId:artifact.id,artifactPath,artifactDirectory:info.isDirectory(),outputDir,tmpDir,signal:controller.signal,resolvePath:async(path='')=>{
      controller.signal.throwIfAborted();
      if (!info.isDirectory()&&path) throw new Error('File Artifact does not accept an internal path.');
      return path?scopedPath(artifactPath,path):artifactPath;
    },resolveExecutionPath:async(path:string)=>{
      controller.signal.throwIfAborted();
      return resolveExecutionInput(root,declaredMetadata.executionPaths??[],path);
    }};
    try {
      const value=action==='preflight'?(definition.preflight?await definition.preflight(context):{ok:true,message:'Registered; no custom preflight, actual execution unverified.'}):await definition.execute(context,validateArguments(definition.metadata.inputSchema,args));
      process.send?.({id,value:jsonCopy(value)});
    } finally { process.off('SIGTERM',abort); }
  } catch(error) { process.send?.({id,error:{message:error instanceof Error?error.message:'Tool host failed.',code:'ARTIFACT_TOOL_FAILED'}}); }
});
process.on('disconnect',()=>process.exit(0));
