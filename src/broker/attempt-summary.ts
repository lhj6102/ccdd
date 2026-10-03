import type { DatabaseSync } from 'node:sqlite';

export interface AttemptSummary { executorStarts: number; toolCalls: Record<string, number>; wallMs: number }
const duration = (start: string, end: string) => Math.max(0, Date.parse(end) - Date.parse(start)) || 0;
export function beginAttempt(db: DatabaseSync, requestId: string, attemptId: string, startedAt: string, executorStarts: number) {
  db.prepare('INSERT INTO attempt_summaries VALUES(?,?,?,NULL,?)').run(requestId,attemptId,startedAt,JSON.stringify({executorStarts,toolCalls:{}}));
}
export function recordAttemptTool(db: DatabaseSync, requestId: string, attemptId: string | undefined, operation: string) {
  if (!attemptId) return;
  const row = db.prepare('SELECT data FROM attempt_summaries WHERE request_id=? AND attempt_id=?').get(requestId,attemptId);
  if (!row) return;
  const data = JSON.parse(String(row.data)) as Omit<AttemptSummary,'wallMs'>;
  const key = Object.hasOwn(data.toolCalls,operation) || Object.keys(data.toolCalls).length < 256 ? operation : '(other)';
  Object.defineProperty(data.toolCalls,key,{value:(Object.hasOwn(data.toolCalls,key)?data.toolCalls[key]:0)+1,enumerable:true,writable:true,configurable:true});
  db.prepare('UPDATE attempt_summaries SET data=? WHERE request_id=? AND attempt_id=?').run(JSON.stringify(data),requestId,attemptId);
}
export function readAttemptSummary(db: DatabaseSync, requestId: string, attemptId: string | undefined, at = new Date().toISOString()): AttemptSummary | undefined {
  if (!attemptId || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='attempt_summaries'").get()) return;
  const row=db.prepare('SELECT * FROM attempt_summaries WHERE request_id=? AND attempt_id=?').get(requestId,attemptId);
  if (!row) return;
  return { ...JSON.parse(String(row.data)),wallMs:duration(String(row.started_at),String(row.completed_at ?? at)) };
}
export function finishAttempt(db: DatabaseSync, requestId: string, attemptId: string | undefined, at: string) {
  if(attemptId)db.prepare('UPDATE attempt_summaries SET completed_at=COALESCE(completed_at,?) WHERE request_id=? AND attempt_id=?').run(at,requestId,attemptId);
}
