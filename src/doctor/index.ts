import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareReviewRequests } from '../requester/index.js';
import { prepareWorkspace, removeOwnedWorkspaceTree } from '../workspaces/index.js';
import { createArtifactViewer, createArtifactTools, type ArtifactListResult } from '../artifacts/index.js';
import { createHumanArtifactTools } from '../artifacts/human.js';
import { errorCode, errorMessage } from '../executors/errors.js';
import type { ReviewEnvelope, ExecutorRegistry, ExecutionEvent, WorkspaceHandle, WorkspaceMode } from '../contracts.js';


export type DiagnosticScope = { kind: 'chain' } | { kind: 'critic'; criticId: string };
export interface DiagnosticCheck {
  id: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  kind?: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  criticIds?: string[];
  message: string;
  remedy?: string;
  details?: Record<string, unknown>;
}
export interface DiagnosticReport {
  ok: boolean;
  status: 'READY' | 'NOT_READY';
  repoId: string;
  mode: WorkspaceMode;
  snapshotHash?: string;
  scope: DiagnosticScope;
  checkedAt: string;
  checks: DiagnosticCheck[];
}
export interface DiagnoseProjectOptions {
  repoPath: string;
  repoId?: string;
  mode?: WorkspaceMode;
  stateDir?: string;
  criticId?: string;
  executors: Pick<ExecutorRegistry, 'probe' | 'validateWorkspace'>;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void | Promise<void>;
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]: [string, unknown]) => [key, canonical(entry)])) : value;
const scopeFor = (criticId?: string): DiagnosticScope => criticId === undefined ? { kind: 'chain' } : { kind: 'critic', criticId };
const bounded = (value: unknown): string => String(value).slice(0, 2_000);
const remedyFor = (value: unknown): string | undefined => value && typeof value === 'object' && 'remedy' in value && typeof value.remedy === 'string' ? value.remedy : undefined;

async function inspectViewers(request: ReviewEnvelope, worktreePath: string, signal?: AbortSignal) {
  if (request.profile.kind === 'human') {
    const registry = await createHumanArtifactTools({ worktreePath, artifacts: request.artifacts, artifactTypes: request.artifactTypes, signal });
    const checks = await registry.preflight();
    const failed = checks.filter(check => !check.ok);
    if (failed.length) throw new Error(failed.map(check => `${check.toolName}: ${check.message}`).join('; '));
    return { toolNames: registry.tools.map(tool => tool.name), checks, programsLaunched: false };
  }
  const viewer = await createArtifactViewer({ worktreePath, artifacts: request.artifacts, artifactTypes: request.artifactTypes, signal });
  const registry = createArtifactTools(viewer, { audience: request.profile.kind === 'runtime' ? 'viewer' : 'agent' });
  const hasTool = (name: string) => registry.tools.some(tool => tool.name === name);
  let inspectedFiles = 0;
  const inspectFile = async (artifactId: string, path?: string): Promise<void> => {
    if (!hasTool(`read_${artifactId}`)) return;
    if (++inspectedFiles > 10_000) throw new Error('Artifact viewer readiness check exceeds 10000 files; narrow the Critic artifact scope.');
    await registry.call(`read_${artifactId}`, { ...(path ? { path } : {}), startLine: 1, lineCount: 80 });
  };
  const inspectDirectory = async (artifactId: string, path = ''): Promise<void> => {
    let offset: number | null = 0;
    do {
      const listing: ArtifactListResult = hasTool(`list_${artifactId}`)
        ? await registry.call(`list_${artifactId}`, { path, offset })
        : await viewer.list({ artifactId, path, offset });
      for (const entry of listing.entries) {
        if (entry.kind === 'directory') await inspectDirectory(artifactId, entry.path);
        else if (entry.kind === 'file') await inspectFile(artifactId, entry.path);
        else throw new Error(`Unsupported artifact entry: ${entry.path}`);
      }
      offset = listing.nextOffset;
    } while (offset !== null);
  };
  for (const artifact of viewer.listArtifacts()) {
    if (artifact.directory) await inspectDirectory(artifact.id);
    else await inspectFile(artifact.id);
  }
  return { toolNames: registry.tools.map(tool => tool.name), inspectedFiles, readLimitLinesPerFile: 80, readLimitBytesPerFile: 65_536 };
}

/** Ephemeral diagnostics: no broker, review history, verdict, test or notification. */
export async function diagnoseProject({ repoPath, repoId = 'demo', mode = 'copy', stateDir, criticId, executors, signal, onEvent = () => {} }: DiagnoseProjectOptions): Promise<DiagnosticReport> {
  const report: DiagnosticReport = { ok: false, status: 'NOT_READY', repoId, mode, scope: scopeFor(criticId), checkedAt: new Date().toISOString(), checks: [] };
  const add = async (check: DiagnosticCheck): Promise<void> => { report.checks.push(check); await onEvent({ type: 'doctor.check', check }); };
  let scratch: string | undefined, workspace: WorkspaceHandle | undefined;
  try {
    if (signal?.aborted) throw Object.assign(new Error('진단이 취소되었습니다.'), { code: 'ABORTED' });
    try { await executors.validateWorkspace?.(repoPath); }
    catch (error) {
      await add({ id: 'workspace-preflight', status: 'FAIL', kind: 'workspace', message: errorCode(error) ? bounded(errorMessage(error)) : '진단 입력의 사전 조건을 확인하지 못했습니다.', remedy: remedyFor(error) ?? '인증 파일과 실행 상태의 경로가 리뷰 workspace 밖에 있는지 확인하세요.', details: { code: errorCode(error) ?? 'WORKSPACE_PREFLIGHT_FAILED' } });
      return report;
    }
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-doctor-')));
    try {
      workspace = await prepareWorkspace({ repoPath, stateDir: stateDir ?? join(scratch, 'state'), mode, signal });
      report.snapshotHash = workspace.descriptor.hash;
      await add({ id: 'workspace-input', status: 'PASS', kind: 'workspace', message: mode === 'copy' ? '현재 repo 전체의 불변 복사본을 진단 입력으로 준비했습니다.' : '현재 workspace 전체의 변경 감시를 시작했습니다.', details: { mode, snapshotHash: report.snapshotHash } });
    } catch (error) {
      await add({ id: 'workspace-input', status: 'FAIL', kind: 'workspace', message: bounded(errorMessage(error)), remedy: '현재 repo의 읽기 권한과 repo 밖의 CCDD 저장 경로를 확인하세요. 복사 도중에는 입력을 변경하지 마세요.', details: { code: signal?.aborted ? 'ABORTED' : errorCode(error) ?? 'WORKSPACE_UNAVAILABLE' } });
      return report;
    }
    const worktreePath = workspace.descriptor.path;
    let requests: ReviewEnvelope[];
    try {
      requests = await prepareReviewRequests({ repoPath: worktreePath, repoId, snapshotHash: workspace.descriptor.hash, criticId });
      await workspace.assertUnchanged();
      await add({ id: 'workspace-config', status: 'PASS', kind: 'workspace', criticIds: requests.map(x => x.criticId), message: '현재 workspace의 설정과 Artifact 정의를 확인했습니다.' });
    } catch (error) {
      await add({ id: 'workspace-config', status: 'FAIL', kind: 'workspace', message: bounded(errorMessage(error)), remedy: '현재 ccdd.config.json, Artifact 경로와 Critic 식별자를 확인하세요.', details: { code: errorCode(error) ?? 'WORKSPACE_CONFIG_INVALID' } });
      return report;
    }
    const readyViewers = new Set<string>();
    for (const request of requests) {
      if (workspace.signal.aborted) break;
      try {
        const details = await inspectViewers(request, worktreePath, workspace.signal);
        readyViewers.add(request.criticId);
        await add({ id: `artifacts:${request.criticId}`, status: 'PASS', kind: 'artifacts', criticIds: [request.criticId], message: request.profile.kind === 'human' ? 'Human Artifact 도구의 등록과 실행 준비를 확인했습니다. 프로그램은 실행하지 않았습니다.' : '스냅샷의 Artifact Viewer 목록·읽기 진입점을 확인했습니다.', details });
      } catch (error) {
        await add({ id: `artifacts:${request.criticId}`, status: 'FAIL', kind: 'artifacts', criticIds: [request.criticId], message: bounded(errorMessage(error)), remedy: 'Artifact 경로·유형·내용과 읽기 권한을 확인하세요.', details: { code: 'ARTIFACT_VIEWER_UNAVAILABLE' } });
      }
    }
    const groups = new Map<string, ReviewEnvelope[]>();
    for (const request of requests) {
      // Provider probes are profile-wide; runtime path readiness is per Critic
      // because identical commands can have different declared artifact scopes.
      const key = request.profile.kind === 'runtime' ? `runtime:${request.criticId}` : JSON.stringify(canonical(request.profile));
      const group = groups.get(key) ?? [];
      group.push(request);
      groups.set(key, group);
    }
    let index = 0;
    for (const group of groups.values()) {
      index++;
      const request = group.find(x => readyViewers.has(x.criticId)) ?? group[0];
      const base = { id: `executor:${index}`, kind: request.profile.kind, ...(request.profile.kind === 'agent' ? { provider: request.profile.provider, model: request.profile.model, reasoning: request.profile.reasoning } : {}), criticIds: group.map(x => x.criticId) };
      if (workspace.signal.aborted) {
        await add({ ...base, status: 'FAIL', message: '진단이 취소되었습니다.', remedy: '필요하면 doctor를 다시 실행하세요.', details: { code: 'ABORTED' } });
        continue;
      }
      if (!readyViewers.has(request.criticId)) {
        await add({ ...base, status: 'SKIP', message: 'Artifact Viewer 준비 실패로 실행기 실사용 진단을 수행하지 않았습니다.' });
        continue;
      }
      try {
        if (typeof executors?.probe !== 'function') throw Object.assign(new Error('실행기에 실사용 진단 기능이 없습니다.'), { code: 'PROBE_UNSUPPORTED', remedy: 'probe를 제공하는 실행기를 등록하세요.' });
        const result = await executors.probe(request, { worktreePath, workspacePath: worktreePath, runDir: resolve(scratch, `probe-${index}`), signal: workspace.signal, onEvent });
        if (result?.ok !== true) throw Object.assign(new Error(result?.message ?? '실행기 준비 상태를 확인하지 못했습니다.'), { code: 'PROBE_FAILED', remedy: result?.remedy });
        await add({ ...base, status: 'PASS', message: result.message, details: result.details });
      } catch (error) {
        // Unknown adapter failures get a safe generic diagnostic, not raw output.
        await add({ ...base, status: 'FAIL', message: errorCode(error) ? bounded(errorMessage(error)) : '실행기의 실사용 진단을 완료하지 못했습니다.', remedy: remedyFor(error) ?? 'Provider 설정·연결과 실행 환경을 확인한 뒤 다시 진단하세요.', details: { code: errorCode(error) ?? 'PROBE_FAILED' } });
      }
    }
    await workspace.assertUnchanged();
  } catch (error) {
    const code = errorCode(error) ?? (signal?.aborted ? 'ABORTED' : 'DIAGNOSTIC_FAILED');
    const changed = ['WORKSPACE_CHANGED', 'WORKSPACE_CACHE_TAMPERED'].includes(code);
    await add({ id: changed ? 'workspace-unchanged' : 'diagnostic', status: 'FAIL', kind: 'workspace', message: changed ? '진단 도중 리뷰 입력이 변경되었습니다.' : code === 'ABORTED' ? '진단이 취소되었습니다.' : '진단을 완료하지 못했습니다.', remedy: changed ? '진단 입력을 변경하지 않은 상태에서 doctor를 다시 실행하세요.' : '로컬 실행 환경과 권한을 확인한 뒤 다시 진단하세요.', details: { code } });
  } finally {
    if (workspace) {
      try { await workspace.close(); }
      catch (error) { await add({ id: 'workspace-cleanup', status: 'FAIL', message: '진단용 workspace 감시를 정리하지 못했습니다.', remedy: 'CCDD 저장 경로의 권한을 확인하세요.', details: { code: errorCode(error) ?? 'CLEANUP_FAILED' } }); }
    }
    if (scratch) {
      try { await removeOwnedWorkspaceTree(scratch); }
      catch { await add({ id: 'temporary-cleanup', status: 'FAIL', message: '진단 임시 파일을 정리하지 못했습니다.', remedy: '임시 디렉터리의 쓰기 권한을 확인하세요.', details: { code: 'CLEANUP_FAILED' } }); }
    }
    report.ok = report.checks.length > 0 && report.checks.every(check => check.status === 'PASS');
    report.status = report.ok ? 'READY' : 'NOT_READY';
    report.checkedAt = new Date().toISOString();
  }
  return report;
}
