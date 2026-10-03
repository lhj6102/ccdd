import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { withProjectStore, projectRequests } from './store.js';
import { readChanges, type ChangeOptions } from '../broker/changes.js';
import { reviewReference } from '../result-view.js';
import { readAttemptSummary } from '../broker/attempt-summary.js';
import type { ReviewRequest } from '../contracts.js';

/** Read-only lifecycle pages, with immutable per-attempt attribution. No worker is started. */
export function projectChanges(stateDir: string, runId: string, options: ChangeOptions = {}) {
  return withProjectStore(stateDir, db => readChanges(db,runId,stateDir,options), null);
}
export function projectRunState(stateDir: string, runId: string) {
  return withProjectStore(stateDir, db => {
    const row=db.prepare('SELECT status FROM runs WHERE id=?').get(runId);
    return row ? String(row.status) : null;
  }, null);
}
export interface ResultStreamOptions extends ChangeOptions { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number }
/** Backpressure-friendly terminal results. Returning or aborting the iterator never cancels execution. */
export async function* streamProjectResults(stateDir: string, runId: string, { after = 0, limit = 32, signal, timeoutMs = 600000, pollIntervalMs = 100 }: ResultStreamOptions = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5000) throw new Error('Invalid result stream timeout or polling interval.');
  const deadline=performance.now()+timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const page=projectChanges(stateDir,runId,{after,limit});
    if(!page)throw new Error('Review handle not found.');
    for(const change of page.changes) {
      signal?.throwIfAborted(); after=change.cursor;
      if(['GREEN','RED','ERROR'].includes(change.status)) yield { type:'result' as const,runId,reference:reviewReference(stateDir,runId,change.requestId),...change };
    }
    after=page.cursor;
    if(page.hasMore)continue;
    if(['GREEN','RED','ERROR','INCOMPLETE'].includes(page.status))return;
    const remaining=deadline-performance.now();
    if(remaining<=0)throw Object.assign(new Error('Result stream timed out; execution was not cancelled.'),{code:'RESULT_STREAM_TIMEOUT',cursor:after});
    await delay(Math.min(pollIntervalMs,remaining),undefined,{signal});
  }
}

export interface AttemptTelemetry {
  attemptId: string; executorStarts: number; wallMs: number; toolCalls: Record<string,number>;
  usageState: 'reported'|'unreported'; usage?: ReviewRequest['usage'];
}
export function projectRequestSummary(stateDir: string, requestId: string) {
  return withProjectStore(stateDir,db=>{
    const row=db.prepare('SELECT data FROM requests WHERE id=?').get(requestId); if(!row)return null;
    const header=JSON.parse(String(row.data)) as Record<string,any>;
    const hasSummaries=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_summaries'").get());
    const attempts: AttemptTelemetry[] = hasSummaries ? db.prepare('SELECT attempt_id FROM attempt_summaries WHERE request_id=? ORDER BY rowid').all(requestId).map(row=>{
      const attemptId=String(row.attempt_id), summary=readAttemptSummary(db,requestId,attemptId)!;
      const usage=db.prepare('SELECT data FROM request_usage WHERE request_id=? AND attempt_id=?').get(requestId,attemptId);
      return {attemptId,...summary,usageState:usage ? 'reported' as const : 'unreported' as const,...(usage ? {usage:JSON.parse(String(usage.data))} : {})};
    }) : [];
    const wallMs=Math.max(0,Date.parse(header.completedAt ?? new Date().toISOString())-Date.parse(header.createdAt))||0;
    return {requestId,runId:String(header.runId),criticId:String(header.criticId),status:String(header.status),wallMs,
      executorStarts:attempts.reduce((sum,a)=>sum+a.executorStarts,0),attempts,
      executionSource:header.executionSource ?? null,sourceSummary:header.sourceSummary ?? null,
      usageState:attempts.some(a=>a.usageState==='reported') ? attempts.some(a=>a.usageState==='unreported') ? 'partial' as const : 'reported' as const : 'unreported' as const};
  },null);
}

/** Explicit O(attempts) aggregation, not an idle-polling endpoint. Reuse is not billed twice. */
export function projectRunSummary(stateDir: string, runId: string) {
  return withProjectStore(stateDir,db=>{
    const row=db.prepare('SELECT data FROM runs WHERE id=?').get(runId);if(!row)return null;
    const run=JSON.parse(String(row.data)), totals:Record<string,number>={}, toolCalls:Record<string,number>={};
    const states=db.prepare('SELECT state,count(*) AS n FROM run_members WHERE run_id=? GROUP BY state').all(runId);
    let executorStarts=0,attempts=0,reported=0,unreported=0;
    const hasSummaries=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_summaries'").get());
    const rows=hasSummaries ? db.prepare("SELECT a.*,u.data AS usage FROM attempt_summaries a JOIN requests r ON r.id=a.request_id LEFT JOIN request_usage u ON u.request_id=a.request_id AND u.attempt_id=a.attempt_id WHERE r.run_id=?").all(runId) : [];
    for(const row of rows) {
      const data=JSON.parse(String(row.data));attempts++;executorStarts+=data.executorStarts;
      if(data.executorStarts>0) {
        if(row.usage) { reported++; for(const [key,value] of Object.entries(JSON.parse(String(row.usage))))totals[key]=(totals[key]??0)+Number(value); }
        else unreported++;
        for(const [key,value] of Object.entries(data.toolCalls))Object.defineProperty(toolCalls,key,{value:(Object.hasOwn(toolCalls,key)?toolCalls[key]:0)+Number(value),enumerable:true,writable:true,configurable:true});
      } else if(!JSON.parse(String(db.prepare('SELECT data FROM requests WHERE id=?').get(row.request_id)!.data)).cacheDisposition) {
        // Local Human tools are real work, but never Provider executor starts.
        for(const [key,value] of Object.entries(data.toolCalls))Object.defineProperty(toolCalls,key,{value:(Object.hasOwn(toolCalls,key)?toolCalls[key]:0)+Number(value),enumerable:true,writable:true,configurable:true});
      }
    }
    const missing=hasSummaries ? Number(db.prepare("SELECT count(*) AS n FROM requests r WHERE r.run_id=? AND json_extract(r.data,'$.attemptId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM attempt_summaries a WHERE a.request_id=r.id AND a.attempt_id=json_extract(r.data,'$.attemptId')) AND json_extract(r.data,'$.cacheDisposition') IS NULL").get(runId)!.n) : Number(db.prepare("SELECT count(*) AS n FROM requests WHERE run_id=? AND json_extract(data,'$.attemptId') IS NOT NULL").get(runId)!.n);
    const wallMs=Math.max(0,Date.parse(run.completedAt ?? new Date().toISOString())-Date.parse(run.createdAt))||0;
    return {runId,status:run.status,wallMs,executorStarts,attempts,toolCalls,counts:Object.fromEntries(states.map(row=>[String(row.state),Number(row.n)])),
      usageState:reported ? unreported||missing ? 'partial' as const : 'reported' as const : 'unreported' as const,
      reportedAttempts:reported,unreportedAttempts:unreported+missing,...(reported ? {usage:totals} : {})};
  },null);
}

export interface RunReference { stateDir: string; runId: string }
/** Compare stored results only. Differences never invalidate either identity or invoke an executor. */
export function compareProjectRuns(left: RunReference, right: RunReference) {
  if(!projectRunState(left.stateDir,left.runId)||!projectRunState(right.stateDir,right.runId))throw new Error('Both stored Run handles must exist.');
  const a=new Map(projectRequests(left.stateDir,left.runId).map(request=>[request.criticId,request]));
  const b=new Map(projectRequests(right.stateDir,right.runId).map(request=>[request.criticId,request]));
  return {left:{...left},right:{...right},items:[...new Set([...a.keys(),...b.keys()])].sort().map(criticId=>{
    const first=a.get(criticId)??null, second=b.get(criticId)??null;
    const semantic=(request: typeof first) => { if(!request?.result)return null;const {reference,reusedFrom,executionProvenance,profile,...result}=request.result;return result; };
    return {criticId,left:first,right:second,differences:{missing:!first||!second,input:first?.inputKey!==second?.inputKey,status:first?.status!==second?.status,
      result:!isDeepStrictEqual(semantic(first),semantic(second)),profile:!isDeepStrictEqual(first?.profile,second?.profile),provenance:!isDeepStrictEqual(first?.executionProvenance,second?.executionProvenance)}};
  })};
}
