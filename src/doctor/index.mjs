import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareReviewRequests } from '../requester/index.mjs';
import { prepareWorkspace, removeOwnedWorkspaceTree } from '../workspaces/index.mjs';
import { createArtifactViewer, createArtifactTools } from '../artifacts/index.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const scopeFor = criticId => criticId === undefined ? { kind: 'chain' } : { kind: 'critic', criticId };
const bounded = value => String(value).slice(0, 2_000);

async function inspectViewers(request, worktreePath) {
  const viewer = await createArtifactViewer({ worktreePath, artifacts: request.artifacts, artifactTypes: request.artifactTypes });
  const registry = createArtifactTools(viewer);
  let inspectedFiles = 0;
  const inspectFile = async (artifactId, path) => {
    if (++inspectedFiles > 10_000) throw new Error('Artifact viewer readiness check exceeds 10000 files; narrow the Critic artifact scope.');
    await registry.call(`read_${artifactId}`, { ...(path ? { path } : {}), startLine: 1, lineCount: 80 });
  };
  const inspectDirectory = async (artifactId, path = '') => {
    let offset = 0;
    do {
      const listing = await registry.call(`list_${artifactId}`, { path, offset });
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
export async function diagnoseProject({ repoPath, repoId = 'demo', mode = 'copy', stateDir, criticId, executors, signal, onEvent = () => {} }) {
  const report = { ok: false, status: 'NOT_READY', repoId, mode, scope: scopeFor(criticId), checkedAt: new Date().toISOString(), checks: [] };
  const add = async check => { report.checks.push(check); await onEvent({ type: 'doctor.check', check }); };
  let scratch, workspace;
  try {
    if (signal?.aborted) throw Object.assign(new Error('진단이 취소되었습니다.'), { code: 'ABORTED' });
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-doctor-')));
    try {
      workspace = await prepareWorkspace({ repoPath, stateDir: stateDir ?? join(scratch, 'state'), mode, signal });
      report.snapshotHash = workspace.descriptor.hash;
      await add({ id: 'workspace-input', status: 'PASS', kind: 'workspace', message: mode === 'copy' ? '현재 repo 전체의 불변 복사본을 진단 입력으로 준비했습니다.' : '현재 workspace 전체의 변경 감시를 시작했습니다.', details: { mode, snapshotHash: report.snapshotHash } });
    } catch (error) {
      await add({ id: 'workspace-input', status: 'FAIL', kind: 'workspace', message: bounded(error.message), remedy: '현재 repo의 읽기 권한과 repo 밖의 CCDD 저장 경로를 확인하세요. 복사 도중에는 입력을 변경하지 마세요.', details: { code: signal?.aborted ? 'ABORTED' : error.code ?? 'WORKSPACE_UNAVAILABLE' } });
      return report;
    }
    const worktreePath = workspace.descriptor.path;
    let requests;
    try {
      requests = await prepareReviewRequests({ repoPath: worktreePath, repoId, snapshotHash: report.snapshotHash, criticId });
      await workspace.assertUnchanged();
      await add({ id: 'workspace-config', status: 'PASS', kind: 'workspace', criticIds: requests.map(x => x.criticId), message: '현재 workspace의 설정과 Artifact 정의를 확인했습니다.' });
    } catch (error) {
      await add({ id: 'workspace-config', status: 'FAIL', kind: 'workspace', message: bounded(error.message), remedy: '현재 ccdd.config.json, Artifact 경로와 Critic 식별자를 확인하세요.', details: { code: error.code ?? 'WORKSPACE_CONFIG_INVALID' } });
      return report;
    }
    const readyViewers = new Set();
    for (const request of requests) {
      if (workspace.signal.aborted) break;
      try {
        const details = await inspectViewers(request, worktreePath);
        readyViewers.add(request.criticId);
        await add({ id: `artifacts:${request.criticId}`, status: 'PASS', kind: 'artifacts', criticIds: [request.criticId], message: '스냅샷의 Artifact Viewer 목록·읽기 진입점을 확인했습니다.', details });
      } catch (error) {
        await add({ id: `artifacts:${request.criticId}`, status: 'FAIL', kind: 'artifacts', criticIds: [request.criticId], message: bounded(error.message), remedy: 'Artifact 경로·유형·내용과 읽기 권한을 확인하세요.', details: { code: 'ARTIFACT_VIEWER_UNAVAILABLE' } });
      }
    }
    const groups = new Map();
    for (const request of requests) {
      // Provider probes are profile-wide; runtime path readiness is per Critic
      // because identical commands can have different declared artifact scopes.
      const key = request.profile.kind === 'runtime' ? `runtime:${request.criticId}` : JSON.stringify(canonical(request.profile));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(request);
    }
    let index = 0;
    for (const group of groups.values()) {
      index++;
      const request = group.find(x => readyViewers.has(x.criticId)) ?? group[0];
      const { kind, provider, model, reasoning } = request.profile;
      const base = { id: `executor:${index}`, kind, ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}), criticIds: group.map(x => x.criticId) };
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
        await add({ ...base, status: 'FAIL', message: error.code ? bounded(error.message) : '실행기의 실사용 진단을 완료하지 못했습니다.', remedy: error.remedy ?? 'Provider 설정·연결과 실행 환경을 확인한 뒤 다시 진단하세요.', details: { code: typeof error.code === 'string' ? error.code : 'PROBE_FAILED' } });
      }
    }
    await workspace.assertUnchanged();
  } catch (error) {
    const code = error.code ?? (signal?.aborted ? 'ABORTED' : 'DIAGNOSTIC_FAILED');
    const changed = ['WORKSPACE_CHANGED', 'WORKSPACE_CACHE_TAMPERED'].includes(code);
    await add({ id: changed ? 'workspace-unchanged' : 'diagnostic', status: 'FAIL', kind: 'workspace', message: changed ? '진단 도중 리뷰 입력이 변경되었습니다.' : code === 'ABORTED' ? '진단이 취소되었습니다.' : '진단을 완료하지 못했습니다.', remedy: changed ? '진단 입력을 변경하지 않은 상태에서 doctor를 다시 실행하세요.' : '로컬 실행 환경과 권한을 확인한 뒤 다시 진단하세요.', details: { code } });
  } finally {
    if (workspace) {
      try { await workspace.close(); }
      catch (error) { await add({ id: 'workspace-cleanup', status: 'FAIL', message: '진단용 workspace 감시를 정리하지 못했습니다.', remedy: 'CCDD 저장 경로의 권한을 확인하세요.', details: { code: error.code ?? 'CLEANUP_FAILED' } }); }
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
