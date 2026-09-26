import { records } from '../broker/storage.js';
import { assertStateFormat } from '../state-format.js';
import { semanticResult } from '../response-schema.js';
import { requesterRun, requesterRequest, requesterEvidence, resultView, type ResultDetail, type ResultOptions } from '../result-view.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewRequest } from '../contracts.js';
import type { RunRecord, RunView } from '../broker/index.js';
import type { ValidationEvidence, ProjectPlan } from './types.js';
import { planProject } from './query.js';
import { findCoalescibleRequest } from '../broker/coalescing.js';

export function readEvidence(database: DatabaseSync): ValidationEvidence[] {
  const store = records(database);
  const rows = database.prepare("SELECT data FROM requests WHERE status IN ('GREEN','RED') ORDER BY json_extract(data,'$.completedAt'),rowid").all();
  return rows.flatMap(row => {
    const header = JSON.parse(String(row.data));
    if (!header.inputRef || !header.resultRef || !header.completedAt) return [];
    const input = store.get<ValidationEvidence['input']>(header.inputRef), result = store.get<ReviewRequest['result']>(header.semanticRef);
    if (input.version !== 3 || !/^[a-f0-9]{64}$/.test(input.key) || !result || result.verdict !== header.status) return [];
    return [{ requestId: header.id, runId: header.runId, criticId: header.criticId, input, completedAt: header.completedAt, verdict: result.verdict, result: semanticResult(result) as NonNullable<ReviewRequest['result']> }];
  });
}

/** Existing databases only; no migrations, ownership reconciliation or write connection. */
export function withProjectStore<T>(stateDir: string, read: (database: DatabaseSync) => T, empty: T): T {
  const filename = join(stateDir, 'broker.sqlite');
  if (!existsSync(filename)) return empty;
  // A worker closing the last WAL connection can briefly lock even read-only queries.
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try { database.exec('BEGIN'); assertStateFormat(database); const result = read(database); database.exec('COMMIT'); return result; }
  finally { database.close(); }
}

export function projectHistory<D extends ResultDetail = 'compact'>(stateDir: string, options: ResultOptions<D> = {}) { return withProjectStore(stateDir, db => readEvidence(db).map(evidence => resultView(options, evidence, () => requesterEvidence(evidence, stateDir))), []); }

export type ProjectRunView = RunView & { validation?: ProjectPlan };
// Compact/status consumers do not hydrate request manifests or duplicated Run
// templates/graph. Full audit lookup remains lossless, including 5.0/5.1 records.
const requestProjection = "json_remove(data, '$.artifacts', '$.configManifest', '$.payload', '$.references')";
function readRun(database: DatabaseSync, id: string, full: boolean): ProjectRunView | null {
  const store = records(database), run = store.run(id, full);
  if (!run) return null;
  const requests = database.prepare('SELECT id FROM requests WHERE run_id=? ORDER BY ordinal').all(id).map(row => store.request(String(row.id), full)!);
  const shared = (run.project?.coalescedRequestIds ?? []).map(id => store.request(id, false)!);
  const events = database.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: Number(event.id), runId: String(event.run_id), requestId: event.request_id === null ? null : String(event.request_id), createdAt: String(event.created_at), type: String(event.type), message: String(event.message), ...(event.data ? { data: JSON.parse(String(event.data)) as unknown } : {}) }));
  const owner = database.prepare('SELECT pid, claimed_at FROM run_owners WHERE run_id = ?').get(id);
  return { ...run, scope: run.scope ?? { kind: run.graph ? 'graph' : 'chain' }, requests, events, owner: owner ? { pid: Number(owner.pid), claimedAt: String(owner.claimed_at) } : null,
    ...(run.project?.version === 3 ? { validation: planProject(run.project.snapshot, readEvidence(database).filter(e => !run.project!.evidenceRequestIds || run.project!.evidenceRequestIds.includes(e.requestId)), { selection: run.project.selection, recursive: run.project.recursive, force: run.project.force, ignoreGates: run.project.ignoreGates, runId: id, coalescedRequestIds: run.project.coalescedRequestIds, attempts: [...requests, ...shared] }) } : {}) };
}
export function storedRun(database: DatabaseSync, id: string): ProjectRunView | null { return readRun(database, id, true); }
export function storedRequesterRun(database: DatabaseSync, id: string, stateDir: string) {
  const run = readRun(database, id, false); return run ? requesterRun(run, stateDir) : null;
}
export function storedValidation(database: DatabaseSync, id: string) { return readRun(database, id, false)?.validation; }
export function projectRun(stateDir: string, id: string): ProjectRunView | null { return withProjectStore(stateDir, db => storedRun(db, id), null); }
export function projectRuns<D extends ResultDetail = 'compact'>(stateDir: string, options: ResultOptions<D> = {}) { return withProjectStore(stateDir, db => db.prepare('SELECT id FROM runs ORDER BY created_at DESC, rowid DESC').all().map(row => { const run = readRun(db, String(row.id), options.detail === 'full')!; return resultView(options, run, () => requesterRun(run, stateDir)); }), []); }
export function projectRequests<D extends ResultDetail = 'compact'>(stateDir: string, runId?: string, options: ResultOptions<D> = {}) {
  return withProjectStore(stateDir, db => {
    const store = records(db);
    return (runId ? db.prepare('SELECT id FROM requests WHERE run_id=? ORDER BY ordinal').all(runId) : db.prepare('SELECT id FROM requests ORDER BY rowid').all()).map(row => {
      const request = store.request(String(row.id), options.detail === 'full')!;
      return resultView(options, request, () => requesterRequest(request, stateDir));
    });
  }, []);
}

/** Evidence and active candidates belong to one readonly snapshot; never reconcile stored owners. */
export function currentProjectPlan(stateDir: string, snapshot: Parameters<typeof planProject>[0], options: Parameters<typeof planProject>[2]): ProjectPlan {
  return withProjectStore<ProjectPlan | null>(stateDir, db => planProject(snapshot, readEvidence(db), options, critic => {
    const source = findCoalescibleRequest(db, critic.id, critic.input.key);
    return source ? { requestId: source.request.id, ...(source.leaseExpiresAt ? { leaseExpiresAt: source.leaseExpiresAt } : {}) } : null;
  }), null) ?? planProject(snapshot, [], options);
}
