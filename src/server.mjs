import http from 'node:http';
import {readFile,appendFile,mkdir} from 'node:fs/promises';
import {resolve,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBroker} from './broker/index.mjs';
import {createExecutorRegistry} from './executors/index.mjs';
import {readArtifact} from './artifacts/index.mjs';
import {prepareReviewRequests} from './requester/index.mjs';
import {bundledCodexPath,packageVersion} from './runtime-paths.mjs';
import {diagnoseProject} from './doctor/index.mjs';

const pkgRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const statusError=(status,message)=>Object.assign(new Error(message),{status});
export function createLocalAlarmMethods({stateDir,humanInbox=false}){
  return humanInbox?[{id:'local-inbox',kind:'inbox',notify:async request=>{await mkdir(stateDir,{recursive:true});await appendFile(resolve(stateDir,'human-inbox.jsonl'),JSON.stringify({requestId:request.id,at:new Date().toISOString(),message:`리뷰 요청: ${request.title}`})+'\n');}}]:[];
}
export async function startServer({repoPath,stateDir=resolve(pkgRoot,'.ccdd/state'),manifest,port=4317,codexPath=process.env.CCDD_CODEX_PATH||bundledCodexPath,humanInbox=false,executors:injected,diagnose:runDiagnosis=diagnoseProject}={}){
  await mkdir(stateDir,{recursive:true});
  const alarmMethods=createLocalAlarmMethods({stateDir,humanInbox});
  const executors=injected||createExecutorRegistry({codexPath,alarmMethods});
  const broker=await createBroker({repoPath,stateDir,repoId:manifest?.repoId||'demo',executors});
  let requesterDemo;
  try { requesterDemo=manifest?{...manifest,scenarios:await Promise.all(manifest.scenarios.map(async scenario=>({...scenario,reviewRequests:await prepareReviewRequests({repoPath,repoId:manifest.repoId||'demo',snapshotCommit:scenario.commit})})))}:null; }
  catch(error) { await broker.close(); throw error; }
  let actualPort=port;
  const diagnostics=new Set();
  const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
  const body=async req=>{if(!String(req.headers['content-type']||'').startsWith('application/json'))throw statusError(415,'JSON 요청이 필요합니다.');let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536)throw statusError(413,'요청이 너무 큽니다.');}try{return JSON.parse(text||'{}');}catch{throw statusError(400,'잘못된 JSON입니다.');}};
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';
      if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(host))throw statusError(403,'로컬 접속만 허용합니다.');
      const origin=req.headers.origin;
      if(origin&&![`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`].includes(origin))throw statusError(403,'다른 사이트의 요청을 허용하지 않습니다.');
      const url=new URL(req.url,`http://127.0.0.1:${actualPort}`);const p=url.pathname;
      if(p==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,version:packageVersion,repoId:manifest?.repoId||'demo',humanAlarmMethods:humanInbox?['local-inbox']:[],readinessChecked:false,providerReady:null});
      if(p==='/api/demo'&&req.method==='GET')return send(res,200,requesterDemo||{repoId:'demo',name:'CCDD',scenarios:[],graph:[],provider:{name:'Codex'}});
      if(p==='/api/runs'&&req.method==='GET')return send(res,200,await broker.listRuns());
      if(p==='/api/runs'&&req.method==='POST'){const input=await body(req);if(typeof input.snapshotCommit!=='string')throw statusError(400,'snapshotCommit이 필요합니다.');const run=await broker.submit({snapshotCommit:input.snapshotCommit,requesterId:input.requesterId||'web-demo',reviewRequests:input.reviewRequests,criticId:input.criticId});return send(res,202,run);}
      if(p==='/api/doctor'&&req.method==='POST'){
        const input=await body(req);if(typeof input.snapshotCommit!=='string')throw statusError(400,'snapshotCommit이 필요합니다.');
        const controller=new AbortController();diagnostics.add(controller);
        const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.once('close',disconnect);
        try { const report=await runDiagnosis({repoPath,repoId:manifest?.repoId||'demo',snapshotCommit:input.snapshotCommit,criticId:input.criticId,executors,signal:controller.signal});return send(res,200,report); }
        finally { diagnostics.delete(controller);res.off('close',disconnect); }
      }
      let m=p.match(/^\/api\/runs\/([^/]+)$/);
      if(m&&req.method==='GET'){const run=await broker.getRun(decodeURIComponent(m[1]));if(!run)throw statusError(404,'요청을 찾을 수 없습니다.');return send(res,200,run);}
      m=p.match(/^\/api\/requests\/([^/]+)\/artifacts\/([^/]+)$/);
      if(m&&req.method==='GET'){
        const request=await broker.getRequest(decodeURIComponent(m[1]));if(!request)throw statusError(404,'리뷰 요청을 찾을 수 없습니다.');
        if(!request.worktreePath)throw statusError(409,'리뷰가 시작되면 스냅샷 Viewer를 열 수 있습니다.');
        const result=await readArtifact({worktreePath:request.worktreePath,artifacts:request.artifacts,artifactTypes:request.artifactTypes,artifactId:decodeURIComponent(m[2]),file:url.searchParams.get('file')||undefined});
        return send(res,200,{...result,files:result.files||result.entries,snapshotCommit:request.snapshotCommit});
      }
      m=p.match(/^\/api\/requests\/([^/]+)\/(claim|result)$/);
      if(m&&req.method==='POST'){
        const input=await body(req),id=decodeURIComponent(m[1]);
        const result=m[2]==='claim'?await broker.claimHuman(id,input.reviewerId):await broker.completeHuman(id,input);
        return send(res,200,result);
      }
      m=p.match(/^\/api\/requests\/([^/]+)$/);
      if(m&&req.method==='GET'){const request=await broker.getRequest(decodeURIComponent(m[1]));if(!request)throw statusError(404,'리뷰 요청을 찾을 수 없습니다.');return send(res,200,request);}
      if(req.method!=='GET')throw statusError(404,'경로를 찾을 수 없습니다.');
      const staticPath=p==='/'?'index.html':p.slice(1);
      if(!['index.html','app.js','styles.css','favicon.svg'].includes(staticPath))throw statusError(404,'경로를 찾을 수 없습니다.');
      const data=await readFile(resolve(pkgRoot,'public',staticPath));
      res.writeHead(200,{'content-type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[extname(staticPath)],'cache-control':'no-cache','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; frame-ancestors 'none'"});res.end(data);
    }catch(error){if(!res.headersSent)send(res,error.status||(/not found/i.test(error.message)?404:400),{error:error.message});else res.end();}
  });
  try { await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);}); }
  catch(error) { await broker.close(); throw error; }
  actualPort=server.address().port;
  return {server,broker,url:`http://127.0.0.1:${actualPort}`,close:async()=>{for(const controller of diagnostics)controller.abort();await new Promise(ok=>server.close(ok));await broker.close();}};
}
