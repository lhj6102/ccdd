import { readAttemptSummary } from '../broker/attempt-summary.js';
import { cacheEvidence, snapshotActive } from './cache-evidence.js';
import { diagnosticScope } from '../diagnostic-scope.js';
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
import { executionPublication, type ExecutionPublication } from './publication.js';

export function readEvidence(database: DatabaseSync, runId?: string, publication = executionPublication(database)): ValidationEvidence[] {
  // Preserve the raw verdict for audit, with publication eligibility alongside it.
  const store = records(database);
  const rows = runId === undefined
    ? database.prepare("SELECT data FROM requests WHERE status IN ('GREEN','RED') ORDER BY json_extract(data,'$.completedAt'),rowid").all()
    : database.prepare("SELECT q.data FROM requests q JOIN (SELECT DISTINCT evidence_id FROM run_members WHERE run_id=? AND evidence_id IS NOT NULL) m ON q.id=m.evidence_id WHERE q.status IN ('GREEN','RED') ORDER BY json_extract(q.data,'$.completedAt'),q.rowid").all(runId);
  return rows.flatMap(row => {
    const header = JSON.parse(String(row.data));
    if (!header.inputRef || !header.resultRef || !header.completedAt) return [];
    const input = store.get<ValidationEvidence['input']>(header.inputRef), result = store.get<ReviewRequest['result']>(header.semanticRef);
    if (!result || result.verdict !== header.status) throw new Error('Stored result/status mismatch.');
    if (![3, 4].includes(input.version) || typeof input.key !== 'string') return [];
    return [{ source: header.executionSource, profile: header.profile, executionProvenance: header.executionProvenance ?? null, requestId: header.id, runId: header.runId, criticId: header.criticId, input, completedAt: header.completedAt, verdict: result.verdict, result: semanticResult(result) as NonNullable<ReviewRequest['result']>, ...(publication ? { publication } : {}) }];
  });
}

/** Existing databases only; no migrations, ownership reconciliation or write connection. */
export function withProjectStore<T>(stateDir: string, read: (database: DatabaseSync) => T, empty: T): T {
  const filename = join(stateDir, 'broker.sqlite');
  if (!existsSync(filename)) return empty;
  // A worker closing the last WAL connection can briefly lock even read-only queries.
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try { database.exec('BEGIN'); assertStateFormat(database); if (!diagnosticScope.getStore() && database.prepare("SELECT value FROM metadata WHERE key='diagnostic-only'").get()) throw new Error('Offline diagnostic state cannot supply review evidence.'); const result = read(database); database.exec('COMMIT'); return result; }
  finally { database.close(); }
}

/** The family recorded in each reviewed target's own stored definition, so history needs no current workspace. */
export function evidenceFamilies(stateDir: string, evidence: readonly Pick<ValidationEvidence, 'requestId' | 'input'>[]): Map<string, string> {
  return withProjectStore(stateDir, db => {
    const store = records(db), families = new Map<string, string>();
    for (const { requestId, input } of evidence) {
      const family = store.request(requestId, true)?.artifacts?.find(artifact => artifact.id === input.target.id)?.family?.name;
      if (family !== undefined) families.set(requestId, family);
    }
    return families;
  }, new Map<string, string>());
}
export function projectHistory<D extends ResultDetail = 'compact'>(stateDir: string, options: ResultOptions<D> = {}) { return withProjectStore(stateDir, db => readEvidence(db).map(evidence => resultView(options, evidence, () => requesterEvidence(evidence, stateDir))), []); }

export type ProjectRunView = RunView & { validation?: ProjectPlan; publication?: ExecutionPublication };
// Compact/status consumers do not hydrate request manifests or duplicated Run
// templates/graph. Full audit lookup reconstructs the admitted current-format record.
const requestProjection = "json_remove(data, '$.artifacts', '$.configManifest', '$.payload', '$.references')";
function readRun(database: DatabaseSync, id: string, full: boolean): ProjectRunView | null {
  const store = records(database), run = store.run(id, full);
  if (!run) return null;
  const requests = database.prepare('SELECT id FROM requests WHERE run_id=? ORDER BY ordinal').all(id).map(row => store.request(String(row.id), full)!);
  const shared = (run.project?.coalescedRequestIds ?? []).map(id => store.request(id, false)!);
  const events = full ? database.prepare('SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 500) ORDER BY id').all(id).map(event => ({ id: Number(event.id), runId: String(event.run_id), requestId: event.request_id === null ? null : String(event.request_id), createdAt: String(event.created_at), type: String(event.type), message: String(event.message), ...(event.data ? { data: JSON.parse(String(event.data)) as unknown } : {}) })) : [];
  const owner = database.prepare('SELECT pid, claimed_at FROM run_owners WHERE run_id = ?').get(id);
  // The reviewer's verdict stays in requests as audit. Validation reports an unpublished
  // verdict as an in-progress or failed attempt, never as matching evidence.
  const publication = run.executionOwned ? executionPublication(database) ?? undefined : undefined;
  const unpublished = (request: ReviewRequest): ReviewRequest => !publication || publication.state === 'accepted' || !['GREEN', 'RED'].includes(request.status) ? request
    : { ...request, status: publication.state === 'pending' ? 'RUNNING' : 'ERROR', error: publication.message ?? null, errorCode: publication.code ?? null };
  return { ...run, scope: run.scope ?? { kind: run.graph ? 'graph' : 'chain' }, requests: requests.map(request => ({ ...request, ...(publication ? { publication } : {}) })), events, owner: owner ? { pid: Number(owner.pid), claimedAt: String(owner.claimed_at) } : null,
    ...(publication ? { publication } : {}),
    ...(run.project?.version === 3 ? { validation: planProject(run.project.snapshot, readEvidence(database, id, publication ?? null).filter(e => !run.project!.evidenceRequestIds || run.project!.evidenceRequestIds.includes(e.requestId)), { selection: run.project.selection, recursive: run.project.recursive, force: run.project.force, ignoreGates: run.project.ignoreGates, runId: id, coalescedRequestIds: run.project.coalescedRequestIds, attempts: [...requests.map(unpublished), ...shared] }) } : {}) };
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
    const store = records(db), publication = executionPublication(db);
    return (runId ? db.prepare('SELECT id FROM requests WHERE run_id=? ORDER BY ordinal').all(runId) : db.prepare('SELECT id FROM requests ORDER BY rowid').all()).map(row => {
      const request = { ...store.request(String(row.id), options.detail === 'full')!, ...(publication ? { publication } : {}) };
      return resultView(options, request, () => requesterRequest(request, stateDir));
    });
  }, []);
}

/** Evidence and active candidates belong to one readonly snapshot; never reconcile stored owners. */
export function currentProjectPlan(stateDir: string, snapshot: Parameters<typeof planProject>[0], options: Parameters<typeof planProject>[2]): ProjectPlan {
  const evidence = cacheEvidence(snapshot);
  const active = snapshotActive(snapshot);
  return planProject(snapshot, evidence, options, critic => { const id = critic.input.cacheIdentity ? active.get(critic.input.cacheIdentity) : undefined; return id ? { requestId: id } : null; });
}

/** The stored envelope of one request, read without mutating its state. */
export function projectRequestData(stateDir: string, requestId: string): ReviewRequest | null {
  return withProjectStore(stateDir, db => {
    const request = records(db).request(requestId), publication = executionPublication(db);
    return request ? { ...request, ...(publication ? { publication } : {}) } : null;
  }, null);
}

/** Scalar execution state for subscribers. No manifests, workspaces or input trees are hydrated. */
export function projectRequestState(stateDir: string, requestId: string, summary = true): Record<string, any> | null {
  return withProjectStore(stateDir, db => {
    const row = db.prepare('SELECT data FROM requests WHERE id=?').get(requestId);
    if (!row) return null;
    const header = JSON.parse(String(row.data)) as Record<string, any>;
    const usage = header.attemptId ? db.prepare('SELECT data FROM request_usage WHERE request_id=? AND attempt_id=?').get(requestId,header.attemptId) : null;
    return { ...header, usage: usage ? JSON.parse(String(usage.data)) : undefined, summary: summary ? readAttemptSummary(db,requestId,header.attemptId) : undefined };
  }, null);
}
