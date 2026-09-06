import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { RepoConfig } from '../contracts.js';

export interface ToolHost { config: RepoConfig; call(message:Record<string,unknown>, timeoutMs?:number):Promise<unknown>; close():Promise<void> }
export async function openToolHost(root:string,signal?:AbortSignal):Promise<ToolHost> {
  signal?.throwIfAborted();
  // Repo code does not inherit Provider tokens, preload hooks or configuration from the host environment.
  const env:NodeJS.ProcessEnv={};
  for (const name of ['PATH','LANG','LC_ALL','SYSTEMROOT','WINDIR','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS']) if (process.env[name]) env[name]=process.env[name];
  const child:ChildProcess=fork(fileURLToPath(new URL('./runtime-host.js',import.meta.url)),[],{cwd:root,env,execArgv:[],detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
  let next=0,closed=false,closePromise:Promise<void>|undefined;
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const fail=(error:Error)=>{for(const value of pending.values()){clearTimeout(value.timer);value.reject(error);}pending.clear();};
  const kill=(signal:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
  const groupAlive=()=>{try{if(process.platform==='win32'||!child.pid)return false;process.kill(-child.pid,0);return true;}catch{return false;}};
  const close=():Promise<void>=>{
    if(closePromise)return closePromise; closed=true;
    closePromise=(async()=>{
      signal?.removeEventListener('abort',abort);fail(new Error('Artifact tool host closed.'));
      // A crashed host can leave its subprocesses alive; the process group still belongs to this review.
      kill('SIGTERM');
      const exited=()=>child.exitCode!==null||child.signalCode!==null||!child.pid;
      const active=()=>!exited()||groupAlive();
      const waitForStop=async()=>{
        const deadline=performance.now()+1000;
        while(active()&&performance.now()<deadline)await delay(20);
      };
      await waitForStop();
      if(active())kill('SIGKILL');
      await waitForStop();
      if(active())throw Object.assign(new Error('Artifact tool subprocess cleanup did not complete.'),{code:'ARTIFACT_TOOL_CLEANUP_FAILED'});
    })();
    // Exit/abort can start cleanup while no caller is awaiting it. Keep the original rejecting promise for close().
    void closePromise.catch(()=>{});
    return closePromise;
  };
  const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});
  child.on('error',error=>{fail(error);void close();});
  child.on('exit',()=>{fail(new Error('Artifact tool host exited.'));void close();});
  child.on('message',(message:any)=>{
    const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);
    if(message.error)entry.reject(Object.assign(new Error(String(message.error.message).slice(0,2000)),{code:message.error.code}));else entry.resolve(message.value);
  });
  const call=(message:Record<string,unknown>,timeoutMs=10000):Promise<any>=>new Promise((resolve,reject)=>{
    if(closed||signal?.aborted){reject(new Error('Artifact tool host is closed or cancelled.'));return;}
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('Artifact tool timed out.'),{code:'ARTIFACT_TOOL_TIMEOUT'}));void close();},timeoutMs);
    pending.set(id,{resolve,reject,timer});child.send({id,...message},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  });
  try { const {config}=await call({action:'load',root}); return {config,call,close}; }
  catch(error){await close();throw error;}
}
