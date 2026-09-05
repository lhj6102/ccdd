import {appendFile, mkdir, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export async function localContext({repoPath=process.cwd(),stateDir}={}) {
  repoPath=await realpath(resolve(repoPath));
  const key=createHash('sha256').update(repoPath).digest('hex').slice(0,24);
  return {repoPath,repoId:'local',stateDir:resolve(stateDir ?? join(process.env.CCDD_STATE_HOME || join(homedir(),'.local','state','ccdd'),key))};
}

export function createLocalAlarmMethods({stateDir,humanInbox=false}) {
  return humanInbox ? [{id:'local-inbox',notify:async request=>{
    await mkdir(stateDir,{recursive:true,mode:0o700});
    await appendFile(join(stateDir,'human-inbox.jsonl'),JSON.stringify({
      requestId:request.id,runId:request.runId,at:new Date().toISOString(),
      title:request.title,snapshotHash:request.snapshotHash,
      message:'Human review is waiting. Inspect the request and artifacts, then claim and submit a result with the CCDD CLI.',
    })+'\n',{mode:0o600});
  }}] : [];
}
