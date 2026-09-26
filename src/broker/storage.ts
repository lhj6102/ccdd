import { semanticResult } from '../response-schema.js';
import { canonical } from '../project/identity.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ReviewEnvelope, ReviewRequest } from '../contracts.js';
import type { RunRecord } from './index.js';

/** Immutable Merkle records. A reference is an internal tagged value, not user JSON. */
type Node = { json: unknown } | { array: string[] } | { object: [string, string][] };
export const storageTestHooks: { read?: (bytes: number) => void; write?: (bytes: number) => void } = {};
export function initializeRecords(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS definitions(hash TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_members(run_id TEXT NOT NULL REFERENCES runs(id), critic_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      target TEXT NOT NULL, input_key TEXT NOT NULL, input_ref TEXT NOT NULL, envelope_ref TEXT,
      request_id TEXT, evidence_id TEXT, state TEXT NOT NULL, included INTEGER NOT NULL,
      PRIMARY KEY(run_id,critic_id));
    CREATE INDEX IF NOT EXISTS members_request ON run_members(request_id,run_id);
    CREATE INDEX IF NOT EXISTS members_input ON run_members(critic_id,input_key);
    CREATE INDEX IF NOT EXISTS members_pending ON run_members(run_id,state,request_id);
    CREATE INDEX IF NOT EXISTS members_evidence ON run_members(run_id,evidence_id) WHERE evidence_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS shared_members(run_id TEXT NOT NULL,critic_id TEXT NOT NULL,request_id TEXT NOT NULL,source_run_id TEXT NOT NULL,PRIMARY KEY(run_id,critic_id));
    CREATE INDEX IF NOT EXISTS shared_request ON shared_members(request_id);
    CREATE INDEX IF NOT EXISTS members_run_state ON run_members(run_id,state,ordinal);
    CREATE TABLE IF NOT EXISTS run_counts(run_id TEXT PRIMARY KEY REFERENCES runs(id), queued INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0, waiting INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
      red INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS request_changes(cursor INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,request_id TEXT NOT NULL,critic_id TEXT NOT NULL,status TEXT NOT NULL,result_ref TEXT,error TEXT,error_code TEXT);
    CREATE INDEX IF NOT EXISTS changes_run_cursor ON request_changes(run_id,cursor);
    CREATE TABLE IF NOT EXISTS gate_edges(run_id TEXT NOT NULL,dependent TEXT NOT NULL,dependency TEXT NOT NULL,PRIMARY KEY(run_id,dependent,dependency));
    CREATE INDEX IF NOT EXISTS gates_reverse ON gate_edges(run_id,dependency,dependent);
    CREATE TABLE IF NOT EXISTS gate_counts(run_id TEXT NOT NULL,critic_id TEXT NOT NULL,unmet INTEGER NOT NULL,red INTEGER NOT NULL,PRIMARY KEY(run_id,critic_id));
    CREATE TABLE IF NOT EXISTS run_dependencies(run_id TEXT NOT NULL, artifact_id TEXT NOT NULL,dependency_id TEXT NOT NULL,PRIMARY KEY(run_id,artifact_id,dependency_id));`);
}

export function records(db: DatabaseSync) {
  // Cache encoded nodes only, bounded by bytes. Decoded values are always caller-owned.
  const nodes = new Map<string, string>(); let bytes = 0;
  const remember = (hash: string, data: string) => {
    if (nodes.has(hash) || Buffer.byteLength(data) > 4 * 1024 ** 2) return;
    while (nodes.size && bytes + Buffer.byteLength(data) > 4 * 1024 ** 2) { const first = nodes.keys().next().value!; bytes -= Buffer.byteLength(nodes.get(first)!); nodes.delete(first); }
    nodes.set(hash, data); bytes += Buffer.byteLength(data);
  };
  const insert = db.prepare('INSERT OR IGNORE INTO definitions(hash,data) VALUES (?,?)');
  const read = db.prepare('SELECT data FROM definitions WHERE hash=?');
  const put = (value: unknown): string => {
    const memo = new WeakMap<object, string>();
    const visit = (value: unknown): string => {
      if (value && typeof value === 'object' && memo.has(value)) return memo.get(value)!;
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error('Immutable records must be JSON.');
      const node: Node = json.length < 1024 || !value || typeof value !== 'object' ? { json: value } : Array.isArray(value)
        ? { array: value.map(visit) }
        : { object: Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, visit(v)]) };
      const data = canonical(node), hash = createHash('sha256').update(data).digest('hex');
      // Never infer persistence from the cache: a previous transaction may have rolled back.
      const result = insert.run(hash, data); if (result.changes) storageTestHooks.write?.(Buffer.byteLength(data));
      remember(hash, data); if (value && typeof value === 'object') memo.set(value, hash); return hash;
    };
    return visit(value);
  };
  const get = <T>(hash: string): T => {
    const visit = (hash: string): unknown => {
      let data = nodes.get(hash);
      if (data === undefined) { const row = read.get(hash); if (!row) throw new Error(`Missing immutable definition ${hash}`); data = String(row.data); storageTestHooks.read?.(Buffer.byteLength(data)); remember(hash, data); }
      const node = JSON.parse(data) as Node;
      if ('json' in node) return node.json;
      if ('array' in node) return node.array.map(visit);
      return Object.fromEntries(node.object.map(([key, ref]) => [key, visit(ref)]));
    };
    return visit(hash) as T;
  };
  const packRun = (run: RunRecord) => {
    const { graph, project, workspace, ...header } = run;
    const definitionRef = put({ graph, ...(project ? { project: { ...project, coalescedRequestIds: undefined, evidenceRequestIds: undefined } } : {}) });
    const projection = project ? { project: { ...project, templates: [], snapshot: { ...project.snapshot, config: { ...project.snapshot.config,
      artifacts: Object.fromEntries(Object.entries(project.snapshot.config.artifacts).map(([id, artifact]) => [id, { ...artifact, views: {} }])), configManifest: undefined } } } } : {};
    return { ...header, workspaceRef: put(workspace), definitionRef, projectionRef: put(projection), ...(project ? { project: { version: project.version, selection: project.selection, recursive: project.recursive, force: project.force, ignoreGates: project.ignoreGates } } : {}) };
  };
  const run = (id: string, full = true): RunRecord | null => {
    const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id); if (!row) return null;
    const header = JSON.parse(String(row.data)); const definition = get<{ graph: RunRecord['graph']; project: RunRecord['project'] }>(full ? header.definitionRef : header.projectionRef);
    const { definitionRef: _, projectionRef: __, workspaceRef, ...rest } = header;
    const shared = db.prepare('SELECT DISTINCT m.request_id FROM run_members m JOIN requests q ON q.id=m.request_id WHERE m.run_id=? AND q.run_id!=?').all(id, id).map(row => String(row.request_id));
    const evidence = db.prepare('SELECT DISTINCT evidence_id FROM run_members WHERE run_id=? AND evidence_id IS NOT NULL').all(id).map(row => String(row.evidence_id));
    return { ...rest, workspace: get(workspaceRef), ...definition, ...(definition.project ? { project: { ...definition.project, coalescedRequestIds: shared, ...(header.completedAt ? { evidenceRequestIds: evidence } : {}) } } : {}) };
  };
  const envelopeKeys = ['repoId','snapshotHash','criticId','title','artifacts','references','requiredObservations','configManifest','payload','profile','target','deps','passSchema','failSchema'] as const;
  const packRequest = (request: ReviewRequest) => {
    const header = { ...request } as Record<string, unknown>, envelope: Record<string, unknown> = {};
    for (const key of envelopeKeys) { if (header[key] !== undefined) envelope[key] = header[key]; delete header[key]; }
    const envelopeRef = put(envelope);
    delete header.workspace; delete header.validationInput; delete header.result;
    return { ...header, criticId: request.criticId, target: request.target, profile: { kind: request.profile.kind, ...(request.profile.kind === 'agent' ? { provider: request.profile.provider, model: request.profile.model } : {}) }, envelopeRef,
      workspaceRef: put(request.workspace), inputRef: request.validationInput ? put(request.validationInput) : null,
      inputKey: request.validationInput?.key ?? null, inputVersion: request.validationInput?.version ?? null, title: request.title, snapshotHash: request.snapshotHash, deps: request.deps, resultRef: request.result ? put(request.result) : null, semanticRef: request.result ? put(semanticResult(request.result)) : null };
  };
  const request = (id: string, full = true): ReviewRequest | null => {
    const row = db.prepare('SELECT data FROM requests WHERE id=?').get(id); if (!row) return null;
    const header = JSON.parse(String(row.data));
    const { envelopeRef, workspaceRef, inputRef, resultRef, inputKey: _, inputVersion: __, semanticRef, ...rest } = header;
    return { ...rest, ...(full ? get<ReviewEnvelope>(envelopeRef) : {}), workspace: get(workspaceRef), ...(inputRef ? { validationInput: get(inputRef) } : {}), result: resultRef ? get(full ? resultRef : semanticRef) : null } as ReviewRequest;
  };
  return { put, get, packRun, packRequest, run, request, clear: () => { nodes.clear(); bytes = 0; } };
}
