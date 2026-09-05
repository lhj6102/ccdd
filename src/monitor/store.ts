import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { ArtifactReference, CriticProfile, ReviewRequest, ReviewStatus } from '../contracts.js';
import type { MonitorDetail, MonitorOverview, MonitorProject, MonitorQuery, MonitorRequest, MonitorSources } from './types.js';

interface Source { id: string; stateDir: string; issue?: string }
interface Identity { repoId: string; repoPath: string }
interface Header {
  id: string; runId: string; title: string; criticId: string; status: ReviewStatus; kind: CriticProfile['kind'];
  predecessorId: string | null; createdAt: string; startedAt: string | null; completedAt: string | null;
  claimedAt: string | null; claimedBy: string | null; notifiedAt: string | null; mode: 'copy' | 'lock' | null;
}
interface Owner { pid: number; identity: string | null }
interface Event { id: number; requestId: string | null; type: string; at: string }
interface Snapshot {
  source: Source; project: MonitorProject; identity: Identity | null; requests: Header[];
  owners: Map<string, Owner>; activity: Map<string, string>; events: Event[]; target: Record<string, unknown> | null;
}
export interface MonitorStoredRequest { request: ReviewRequest; repoPath: string; stateDir: string; repoId: string }
type ProcessCheck = { exists: boolean | null; identity: string | null };
type ProcessChecks = Map<number, Promise<ProcessCheck>>;

const statuses = new Set<string>(['BLOCKED', 'QUEUED', 'RUNNING', 'WAITING_HUMAN', 'GREEN', 'RED', 'ERROR']);
const finished = new Set<string>(['GREEN', 'RED', 'ERROR']);
const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): unknown => object(error) ? error.code : undefined;
const projectId = (stateDir: string): string => createHash('sha256').update(stateDir).digest('hex');
const storageError = (): Error => new Error('Invalid monitor source record.');

function string(value: unknown): string {
  if (typeof value !== 'string') throw storageError();
  return value;
}
function nullableString(value: unknown): string | null { return value == null ? null : string(value); }
function date(value: unknown): string {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text))) throw storageError();
  return text;
}
function nullableDate(value: unknown): string | null { return value == null ? null : date(value); }
function json(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(string(value));
  if (!object(parsed)) throw storageError();
  return parsed;
}
function text(value: string, limit: number): string { return value.length <= limit ? value : `${value.slice(0, limit)}…`; }

function readHeader(row: Record<string, unknown>): Header {
  const status = string(row.status), kind = string(row.kind);
  if (!statuses.has(status) || !['agent', 'runtime', 'human'].includes(kind) || row.json_status !== status) throw storageError();
  if (row.id !== row.json_id || row.run_id !== row.json_run_id) throw storageError();
  return {
    id: string(row.id), runId: string(row.run_id), title: text(string(row.title), 500), criticId: string(row.critic_id),
    status: status as ReviewStatus, kind: kind as CriticProfile['kind'], predecessorId: nullableString(row.predecessor_id),
    createdAt: date(row.created_at), startedAt: nullableDate(row.started_at), completedAt: nullableDate(row.completed_at),
    claimedAt: nullableDate(row.claimed_at), claimedBy: nullableString(row.claimed_by), notifiedAt: nullableDate(row.notified_at),
    mode: row.workspace_mode === 'copy' || row.workspace_mode === 'lock' ? row.workspace_mode : null,
  };
}

// The overview query deliberately never selects review payloads, result logs, tool arguments, or credential settings.
const headerSql = `SELECT id,run_id,status,
  json_extract(data,'$.id') AS json_id,json_extract(data,'$.runId') AS json_run_id,json_extract(data,'$.status') AS json_status,
  json_extract(data,'$.title') AS title,json_extract(data,'$.criticId') AS critic_id,json_extract(data,'$.profile.kind') AS kind,
  json_extract(data,'$.predecessorId') AS predecessor_id,json_extract(data,'$.createdAt') AS created_at,
  json_extract(data,'$.startedAt') AS started_at,json_extract(data,'$.completedAt') AS completed_at,
  json_extract(data,'$.claimedAt') AS claimed_at,json_extract(data,'$.claimedBy') AS claimed_by,
  json_extract(data,'$.notifiedAt') AS notified_at,json_extract(data,'$.workspace.mode') AS workspace_mode
  FROM requests`;

/** Open only existing databases. All reads for one source share one SQLite snapshot. */
async function readSnapshot(source: Source, requestId?: string): Promise<Snapshot> {
  const snapshot: Snapshot = {
    source, project: { id: source.id, name: basename(source.stateDir), path: source.stateDir }, identity: null,
    requests: [], owners: new Map(), activity: new Map(), events: [], target: null,
  };
  if (source.issue) { snapshot.project.issue = source.issue; return snapshot; }
  let db: DatabaseSync | undefined;
  try {
    const filename = join(source.stateDir, 'broker.sqlite');
    if (!(await stat(filename)).isFile()) throw storageError();
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('BEGIN');
    const stored = db.prepare("SELECT value FROM metadata WHERE key='registered-repo'").get();
    const identity = json(stored?.value);
    if (typeof identity.repoPath !== 'string' || !isAbsolute(identity.repoPath) || typeof identity.repoId !== 'string') throw storageError();
    snapshot.identity = { repoPath: identity.repoPath, repoId: identity.repoId };
    snapshot.project = { id: source.id, name: basename(identity.repoPath) || identity.repoPath, path: identity.repoPath };
    snapshot.requests = db.prepare(headerSql).all().map(readHeader);
    for (const owner of db.prepare('SELECT run_id,pid,process_identity FROM run_owners').all()) {
      snapshot.owners.set(string(owner.run_id), { pid: typeof owner.pid === 'number' ? owner.pid : NaN, identity: nullableString(owner.process_identity) });
    }
    for (const activity of db.prepare('SELECT request_id,MAX(created_at) AS at FROM events WHERE request_id IS NOT NULL GROUP BY request_id').all()) {
      snapshot.activity.set(string(activity.request_id), date(activity.at));
    }
    if (requestId !== undefined) {
      const header = snapshot.requests.find(request => request.id === requestId);
      if (header) {
        const target = db.prepare('SELECT data FROM requests WHERE id=?').get(requestId);
        snapshot.target = json(target?.data);
        snapshot.events = db.prepare('SELECT id,request_id,type,created_at FROM events WHERE run_id=? AND (request_id=? OR request_id IS NULL) ORDER BY id').all(header.runId, requestId).map(row => ({
          id: Number(row.id), requestId: nullableString(row.request_id), type: string(row.type), at: date(row.created_at),
        }));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch {}
    snapshot.project.issue = codeOf(error) === 'ENOENT' ? '상태 저장소를 찾을 수 없습니다.' : '이 프로젝트의 상태 기록을 읽을 수 없습니다.';
    snapshot.requests = []; snapshot.owners.clear(); snapshot.activity.clear(); snapshot.events = []; snapshot.target = null;
  } finally { db?.close(); }
  return snapshot;
}

async function sourceAt(directory: string, issue?: string): Promise<Source> {
  const stateDir = await realpath(directory).catch(() => resolve(directory));
  return { id: projectId(stateDir), stateDir, ...(issue ? { issue } : {}) };
}

function sourcesReader(options: MonitorSources): () => Promise<Source[]> {
  const stateHome = resolve(options.stateHome ?? process.env.CCDD_STATE_HOME ?? join(homedir(), '.local', 'state', 'ccdd'));
  const explicit = [...(options.stateDirs ?? [])].map(directory => resolve(directory));
  const includeHome = explicit.length === 0 || options.stateHome !== undefined;
  return async () => {
    const sources = new Map<string, Source>();
    try {
      const entries = includeHome ? await readdir(stateHome, { withFileTypes: true }) : [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const directory = join(stateHome, entry.name);
        try {
          if (!(await stat(join(directory, 'broker.sqlite'))).isFile()) continue;
        } catch (error) {
          if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') continue;
        }
        const source = await sourceAt(directory);
        sources.set(source.id, source);
      }
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') {
        const source = await sourceAt(stateHome, '프로젝트 상태 목록을 읽을 수 없습니다.');
        sources.set(source.id, source);
      }
    }
    for (const directory of explicit) {
      const source = await sourceAt(directory);
      sources.set(source.id, source);
    }
    return [...sources.values()];
  };
}

async function inspectProcess(pid: number): Promise<ProcessCheck> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return { exists: null, identity: null };
  try { process.kill(pid, 0); }
  catch (error) { return { exists: codeOf(error) === 'ESRCH' ? false : null, identity: null }; }
  try {
    if (process.platform === 'linux') {
      const info = await readFile(`/proc/${pid}/stat`, 'utf8');
      const start = info.slice(info.lastIndexOf(')') + 2).split(' ')[19];
      return { exists: true, identity: start ? `linux:${start}` : null };
    }
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1_000 });
    return { exists: true, identity: stdout.trim() ? `ps:${stdout.trim()}` : null };
  } catch { return { exists: true, identity: null }; }
}

async function workerState(request: Header, snapshot: Snapshot, checks: ProcessChecks): Promise<MonitorRequest['workerState']> {
  if (finished.has(request.status)) return 'idle';
  const owner = snapshot.owners.get(request.runId);
  if (!owner) {
    if (request.status === 'RUNNING') return 'missing';
    if (request.status === 'WAITING_HUMAN') return request.mode === 'copy' && request.notifiedAt ? 'idle' : request.mode === null ? 'unknown' : 'missing';
    return 'idle';
  }
  let checked = checks.get(owner.pid);
  if (!checked) { checked = inspectProcess(owner.pid); checks.set(owner.pid, checked); }
  const process = await checked;
  if (process.exists === false) return 'missing';
  if (process.exists === null || !owner.identity || !process.identity) return 'unknown';
  return owner.identity === process.identity ? 'alive' : 'missing';
}

function failedPredecessor(request: Header, byId: Map<string, Header>): Header | null {
  const seen = new Set<string>([request.id]);
  let predecessor = request.predecessorId;
  while (predecessor && !seen.has(predecessor)) {
    seen.add(predecessor);
    const previous = byId.get(predecessor);
    if (!previous || previous.runId !== request.runId) break;
    if (previous.status === 'RED' || previous.status === 'ERROR') return previous;
    predecessor = previous.predecessorId;
  }
  return null;
}

function waitingReason(request: Header, state: MonitorRequest['workerState'], byId: Map<string, Header>): string | null {
  if (finished.has(request.status)) return null;
  if (state === 'missing') return '작업을 실행하던 프로세스가 확인되지 않습니다. 저장된 상태를 표시합니다.';
  if (request.status === 'BLOCKED') {
    const failed = failedPredecessor(request, byId);
    if (failed) return `선행 리뷰 “${failed.title}”가 ${failed.status === 'RED' ? '기준을 충족하지 못해' : '오류로 종료되어'} 진행할 수 없습니다.`;
    const previous = request.predecessorId ? byId.get(request.predecessorId) : undefined;
    return previous ? `선행 리뷰 “${previous.title}”의 통과를 기다리고 있습니다.` : '선행 리뷰의 통과를 기다리고 있습니다.';
  }
  if (request.status === 'WAITING_HUMAN') {
    if (!request.notifiedAt) return request.claimedBy ? `${text(request.claimedBy, 200)}님이 맡았으며, 알림 전달을 확인 중입니다.` : '리뷰 알림이 전달되기를 기다리고 있습니다.';
    return request.claimedBy ? `${text(request.claimedBy, 200)}님이 검토 결과를 제출하기를 기다리고 있습니다.` : '이 리뷰를 맡을 사람을 기다리고 있습니다.';
  }
  if (state === 'unknown') return '작업 프로세스의 실행 여부를 확인할 수 없습니다.';
  return request.status === 'QUEUED' ? '리뷰 실행을 기다리고 있습니다.' : null;
}

async function projectRequests(snapshot: Snapshot, checks: ProcessChecks, onlyId?: string): Promise<MonitorRequest[]> {
  const byId = new Map(snapshot.requests.map(request => [request.id, request]));
  return Promise.all(snapshot.requests.filter(request => onlyId === undefined || request.id === onlyId).map(async request => {
    const blockedByFailure = request.status === 'BLOCKED' && failedPredecessor(request, byId) !== null;
    const worker = blockedByFailure ? 'idle' : await workerState(request, snapshot, checks);
    const times = [request.createdAt, request.startedAt, request.completedAt, request.claimedAt, request.notifiedAt, snapshot.activity.get(request.id)].filter((at): at is string => typeof at === 'string');
    return {
      id: request.id, projectId: snapshot.project.id, runId: request.runId, title: request.title, criticId: request.criticId,
      status: request.status, kind: request.kind, createdAt: request.createdAt, startedAt: request.startedAt, completedAt: request.completedAt,
      claimedAt: request.claimedAt, claimedBy: request.claimedBy, activityAt: times.sort((a, b) => Date.parse(b) - Date.parse(a))[0],
      waitingReason: waitingReason(request, worker, byId), workerState: worker, blockedByFailure,
    };
  }));
}

function categories(request: MonitorRequest, byId: Map<string, Header>): { active: boolean; attention: boolean } {
  const header = byId.get(request.id)!;
  const blockedByFailure = header.status === 'BLOCKED' && failedPredecessor(header, byId) !== null;
  return {
    active: !finished.has(request.status) && !blockedByFailure,
    attention: request.status === 'RED' || request.status === 'ERROR' || request.status === 'WAITING_HUMAN' || blockedByFailure || request.workerState === 'missing' || request.workerState === 'unknown',
  };
}

function timeline(request: Header, events: Event[]): MonitorDetail['timeline'] {
  const labels = new Map<string, { at: string; order: number }>();
  const add = (label: string, at: string | null | undefined, order: number) => { if (at && !labels.has(label)) labels.set(label, { at, order }); };
  const eventLabels: Record<string, string> = {
    'run.submitted': '접수', 'request.queued': '실행 대기', 'request.started': '실행 시작',
    'human.waiting': '사람 대기', 'human.notified': '알림 전달', 'human.claimed': '담당',
    'request.completed': '완료', 'request.error': '완료',
  };
  for (const event of events) {
    if (event.requestId === null && event.type !== 'run.submitted') continue;
    const label = eventLabels[event.type];
    if (label) add(label, event.at, event.id);
  }
  add('접수', request.createdAt, -2);
  // The first request is queued atomically with submission; later requests need their own queued event.
  if (!request.predecessorId) add('실행 대기', labels.get('접수')?.at, (labels.get('접수')?.order ?? -2) + 0.5);
  add('실행 시작', request.startedAt, Number.MAX_SAFE_INTEGER - 4);
  add('담당', request.claimedAt, Number.MAX_SAFE_INTEGER - 3);
  add('알림 전달', request.notifiedAt, Number.MAX_SAFE_INTEGER - 2);
  add('완료', request.completedAt, Number.MAX_SAFE_INTEGER - 1);
  return [...labels.entries()].sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at) || a[1].order - b[1].order).map(([label, value]) => ({ label, at: value.at }));
}

function profile(value: unknown): CriticProfile {
  if (!object(value)) throw storageError();
  const timeout = typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) ? { timeoutMs: value.timeoutMs } : {};
  if (value.kind === 'human') return { kind: 'human' };
  if (value.kind === 'agent') return { kind: 'agent', provider: string(value.provider), model: string(value.model), reasoning: string(value.reasoning), ...timeout };
  if (value.kind === 'runtime' && Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')) return { kind: 'runtime', command: string(value.command), args: value.args as string[], ...timeout };
  throw storageError();
}
function artifactReferences(value: unknown): ArtifactReference[] {
  if (!Array.isArray(value)) throw storageError();
  return value.map(item => {
    if (!object(item)) throw storageError();
    return { id: string(item.id), path: string(item.path), type: string(item.type) };
  });
}

/** Optional observer: opening or querying it never runs reconciliation or changes review state. */
export function createMonitorStore(options: MonitorSources = {}) {
  const discover = sourcesReader(options);
  async function selected(project: string, requestId: string): Promise<Snapshot | null> {
    const source = (await discover()).find(candidate => candidate.id === project);
    return source ? readSnapshot(source, requestId) : null;
  }
  return {
    async overview(query: MonitorQuery = {}): Promise<MonitorOverview> {
      const limit = query.limit ?? 50, offset = query.offset ?? 0, filter = query.filter ?? 'all';
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || !['all', 'active', 'attention'].includes(filter)) throw new Error('목록 조회 조건이 올바르지 않습니다.');
      const snapshots = await Promise.all((await discover()).map(source => readSnapshot(source)));
      const projects = snapshots.map(snapshot => snapshot.project).sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));
      const checks: ProcessChecks = new Map();
      const scoped = snapshots.filter(snapshot => query.project === undefined || snapshot.project.id === query.project);
      const rows = (await Promise.all(scoped.map(async snapshot => {
        const byId = new Map(snapshot.requests.map(request => [request.id, request]));
        return (await projectRequests(snapshot, checks)).map(request => ({ request, ...categories(request, byId) }));
      }))).flat();
      const counts = { all: rows.length, active: rows.filter(row => row.active).length, attention: rows.filter(row => row.attention).length };
      const filtered = rows.filter(row => filter === 'all' || row[filter]).sort((a, b) => Number(b.active || b.attention) - Number(a.active || a.attention) || Date.parse(b.request.createdAt) - Date.parse(a.request.createdAt) || a.request.projectId.localeCompare(b.request.projectId) || a.request.id.localeCompare(b.request.id));
      return { projects, requests: filtered.slice(offset, offset + limit).map(row => row.request), total: filtered.length, counts, hasMore: offset + limit < filtered.length, observedAt: new Date().toISOString() };
    },
    async detail(project: string, requestId: string): Promise<MonitorDetail | null> {
      const snapshot = await selected(project, requestId);
      if (!snapshot || snapshot.project.issue || !snapshot.target) return null;
      const header = snapshot.requests.find(request => request.id === requestId);
      if (!header) return null;
      try {
        const raw = snapshot.target;
        if (!object(raw.payload)) throw storageError();
        const outcome = object(raw.result) && typeof raw.result.summary === 'string' && Array.isArray(raw.result.evidence) && raw.result.evidence.every(item => typeof item === 'string')
          ? { summary: text(raw.result.summary, 12_000), evidence: (raw.result.evidence as string[]).slice(0, 100).map(item => text(item, 4_000)) } : null;
        const request = (await projectRequests(snapshot, new Map(), requestId))[0];
        return {
          request, instruction: text(string(raw.payload.instruction), 24_000), profile: profile(raw.profile), result: outcome,
          error: typeof raw.error === 'string' ? text(raw.error, 2_000) : null, timeline: timeline(header, snapshot.events), artifacts: artifactReferences(raw.artifacts),
        };
      } catch { return null; }
    },
    async request(project: string, requestId: string): Promise<MonitorStoredRequest | null> {
      const snapshot = await selected(project, requestId);
      if (!snapshot || snapshot.project.issue || !snapshot.identity || !snapshot.target) return null;
      // This trusted-store JSON edge is internal to the Artifact HTTP adapter; never return it to the browser.
      return { request: snapshot.target as unknown as ReviewRequest, repoPath: snapshot.identity.repoPath, repoId: snapshot.identity.repoId, stateDir: snapshot.source.stateDir };
    },
  };
}
