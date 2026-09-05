#!/usr/bin/env node
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {prepareDemo} from '../scripts/prepare-demo.mjs';
import {startServer} from './server.mjs';
import {bundledCodexPath} from './runtime-paths.mjs';

const args=process.argv.slice(2),cmd=args.shift()||'help';
const has=x=>args.includes(x);
const opt=(x,fallback)=>{const i=args.indexOf(x);return i>=0?args[i+1]:fallback;};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
try{
  if(cmd==='serve'){
    let manifest,repoPath;
    if(has('--demo')){manifest=await prepareDemo();repoPath=manifest.repoPath;}
    else{repoPath=resolve(opt('--repo',process.cwd()));const mf=opt('--manifest');if(mf)manifest=JSON.parse(await readFile(mf,'utf8'));}
    const app=await startServer({repoPath,stateDir:resolve(opt('--state-dir',resolve(root,'.ccdd/state'))),manifest,port:Number(opt('--port',process.env.PORT||'4317')),codexPath:opt('--codex',process.env.CCDD_CODEX_PATH||bundledCodexPath),humanInbox:has('--human-inbox')});
    console.log(`CCDD 0.1.0 · ${app.url}`);
    let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};process.on('SIGINT',close);process.on('SIGTERM',close);
  }else if(cmd==='prepare-demo'){console.log(JSON.stringify(await prepareDemo(),null,2));}
  else if(['run','status','list'].includes(cmd)){
    const url=opt('--url','http://127.0.0.1:4317');
    const positional=[];for(let i=0;i<args.length;i++){if(args[i].startsWith('--'))i++;else positional.push(args[i]);}
    const id=positional[0];
    if(cmd==='run'&&!opt('--commit'))throw new Error('run requires --commit with a full immutable Git commit hash.');
    if(cmd==='status'&&!id)throw new Error('status requires a run ID.');
    const r=cmd==='run'?await fetch(url+'/api/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({snapshotCommit:opt('--commit'),requesterId:opt('--requester','cli')})}):await fetch(url+(cmd==='list'?'/api/runs':`/api/runs/${encodeURIComponent(id)}`));
    const result=await r.json();console.log(JSON.stringify(result,null,2));if(!r.ok)process.exitCode=1;
  }else{
    console.log(`CCDD — critic broker & artifact runner\n\n  ccdd serve --demo [--port 4317] [--human-inbox]\n  ccdd serve --repo PATH [--state-dir PATH] [--codex PATH]\n  ccdd prepare-demo\n  ccdd run --commit HASH [--requester ID]\n  ccdd status RUN_ID\n  ccdd list\n\nNode 24+, Git, Codex login required for Agent reviews.\n`);
  }
}catch(error){console.error(error.message);process.exitCode=1;}
