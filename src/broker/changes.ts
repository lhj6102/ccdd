import type { DatabaseSync } from 'node:sqlite';
import { records } from './storage.js';
import { reviewReference } from '../result-view.js';
import { semanticResult } from '../response-schema.js';

export interface ChangeOptions { after?: number; limit?: number }
/** Indexed keyset pagination. Telemetry does not advance this lifecycle cursor. */
export function readChanges(db: DatabaseSync, runId: string, stateDir: string, { after = 0, limit = 100 }: ChangeOptions = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid change cursor or limit.');
  const row = db.prepare('SELECT status FROM runs WHERE id=?').get(runId);
  if (!row) return null;
  const store = records(db);
  const rows = db.prepare('SELECT * FROM request_changes WHERE run_id=? AND cursor>? ORDER BY cursor LIMIT ?').all(runId, after, limit + 1);
  const resultFor = (row: Record<string, any>) => {
    if (!row.result_ref) return null;
    const result = store.get<Record<string, unknown>>(String(row.result_ref));
    if (!result || result.verdict !== row.status || !['GREEN','RED'].includes(String(row.status))) throw new Error('Stored result/status mismatch.');
    return { ...semanticResult(result), verdict: String(row.status), reference: reviewReference(stateDir, String(db.prepare('SELECT run_id FROM requests WHERE id=?').get(row.request_id)!.run_id), String(row.request_id)) };
  };
  const changes = rows.slice(0, limit).map(row => ({ cursor: Number(row.cursor), requestId: String(row.request_id), criticId: String(row.critic_id), status: String(row.status),
    blockedReason: row.status === 'BLOCKED' || row.status === 'WAIT_DEPENDENCY' || row.status === 'QUEUED' ? (db.prepare("SELECT json_extract(data,'$.blockedReason') AS reason FROM requests WHERE id=?").get(row.request_id)?.reason ?? null) : null,
    result: resultFor(row),
    error: row.error, errorCode: row.error_code }));
  return { runId, status: String(row.status), cursor: changes.at(-1)?.cursor ?? after, hasMore: rows.length > limit, changes };
}
