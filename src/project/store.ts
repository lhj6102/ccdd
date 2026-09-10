import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewRequest } from '../contracts.js';
import type { RunRecord, RunView } from '../broker/index.js';
import type { ValidationEvidence, ProjectPlan } from './types.js';
import { planProject } from './query.js';

export function readEvidence(database: DatabaseSync): ValidationEvidence[] {
  const rows = database.prepare("SELECT data FROM requests WHERE status IN ('GREEN','RED') AND json_extract(data, '$.validationInput.version') = 1 ORDER BY json_extract(data, '$.completedAt'), rowid").all();
  return rows.flatMap(row => {
    const request = JSON.parse(String(row.data)) as ReviewRequest;
    if (!request.validationInput || !/^[a-f0-9]{64}$/.test(request.validationInput.key) || !request.result || request.result.verdict !== request.status || !request.completedAt) return [];
    return [{ requestId: request.id, runId: request.runId, criticId: request.criticId, input: request.validationInput, completedAt: request.completedAt, verdict: request.result.verdict, summary: request.result.summary, evidence: request.result.evidence }];
  });
}

/** Existing databases only; no migrations, ownership reconciliation or write connection. */
export function withProjectStore<T>(stateDir: string, read: (database: DatabaseSync) => T, empty: T): T {
  const filename = join(stateDir, 'broker.sqlite');
  if (!existsSync(filename)) return empty;
  // A worker closing the last WAL connection can briefly lock even read-only queries.
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try { database.exec('BEGIN'); const result = read(database); database.exec('COMMIT'); return result; }
  finally { database.close(); }
}

export function projectHistory(stateDir: string): ValidationEvidence[] { return withProjectStore(stateDir, readEvidence, []); }

export type ProjectRunView = RunView & { validation?: ProjectPlan };
export function storedRun(database: DatabaseSync, id: string): ProjectRunView | null {
  const row = database.prepare('SELECT data FROM runs WHERE id = ?').get(id);
  if (!row) return null;
  const run = JSON.parse(String(row.data)) as RunRecord;
  const requests = database.prepare('SELECT data FROM requests WHERE run_id = ? ORDER BY ordinal').all(id).map(row => JSON.parse(String(row.data)) as ReviewRequest);
  const events = database.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: Number(event.id), runId: String(event.run_id), requestId: event.request_id === null ? null : String(event.request_id), createdAt: String(event.created_at), type: String(event.type), message: String(event.message) }));
  const owner = database.prepare('SELECT pid, claimed_at FROM run_owners WHERE run_id = ?').get(id);
  return { ...run, scope: run.scope ?? { kind: run.graph ? 'graph' : 'chain' }, requests, events, owner: owner ? { pid: Number(owner.pid), claimedAt: String(owner.claimed_at) } : null,
    ...(run.project ? { validation: planProject(run.project.snapshot, readEvidence(database).filter(e => !run.project!.evidenceRequestIds || run.project!.evidenceRequestIds.includes(e.requestId)), { selection: run.project.selection, recursive: run.project.recursive, force: run.project.force, runId: id, attempts: requests }) } : {}) };
}
export function projectRun(stateDir: string, id: string): ProjectRunView | null { return withProjectStore(stateDir, db => storedRun(db, id), null); }
export function projectRuns(stateDir: string): ProjectRunView[] { return withProjectStore(stateDir, db => db.prepare('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC').all().map(row => storedRun(db, String(row.id))!), []); }
export function projectRequests(stateDir: string, runId?: string): ReviewRequest[] {
  return withProjectStore(stateDir, db => (runId ? db.prepare('SELECT data FROM requests WHERE run_id = ? ORDER BY ordinal').all(runId) : db.prepare("SELECT data FROM requests ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC").all()).map(row => JSON.parse(String(row.data)) as ReviewRequest), []);
}
