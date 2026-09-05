import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareReviewRequests } from '../requester/index.mjs';
import { git } from '../broker/config.mjs';
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
    await registry.call(`read_${artifactId}`, { ...(path ? { path } : {}), limit: 65_536 });
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
  return { toolNames: registry.tools.map(tool => tool.name), inspectedFiles, readLimitBytesPerFile: 65_536 };
}

/** Ephemeral diagnostics: no broker, database, verdict, project test or notification. */
export async function diagnoseProject({ repoPath, repoId = 'demo', snapshotCommit, criticId, executors, signal, onEvent = () => {} }) {
  const report = { ok: false, status: 'NOT_READY', repoId, snapshotCommit, scope: scopeFor(criticId), checkedAt: new Date().toISOString(), checks: [] };
  const add = async check => { report.checks.push(check); await onEvent({ type: 'doctor.check', check }); };
  let scratch, worktreePath, hooksPath, worktreeCreated = false;
  try {
    if (signal?.aborted) throw Object.assign(new Error('진단이 취소되었습니다.'), { code: 'ABORTED' });
    let requests;
    try {
      requests = await prepareReviewRequests({ repoPath, repoId, snapshotCommit, criticId });
      await add({ id: 'snapshot-config', status: 'PASS', kind: 'snapshot', criticIds: requests.map(x => x.criticId), message: '요청한 불변 커밋의 설정과 Artifact 정의를 확인했습니다.' });
    } catch (error) {
      await add({ id: 'snapshot-config', status: 'FAIL', kind: 'snapshot', message: bounded(error.message), remedy: '저장소, 전체 커밋 해시, 커밋된 ccdd.config.json과 Critic 식별자를 확인하세요.', details: { code: 'SNAPSHOT_CONFIG_INVALID' } });
      return report;
    }
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-doctor-')));
    worktreePath = join(scratch, 'snapshot');
    hooksPath = join(scratch, 'empty-hooks');
    await mkdir(hooksPath);
    try {
      await git(repoPath, ['-c', `core.hooksPath=${hooksPath}`, 'worktree', 'add', '--detach', worktreePath, snapshotCommit], { signal });
      worktreeCreated = true;
      const head = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
      if (head !== snapshotCommit.toLowerCase()) throw new Error('Detached worktree snapshot does not match the requested commit.');
      await add({ id: 'snapshot-worktree', status: 'PASS', kind: 'snapshot', message: '진단용 detached worktree에서 요청 스냅샷을 재현했습니다.' });
    } catch (error) {
      await add({ id: 'snapshot-worktree', status: 'FAIL', kind: 'snapshot', message: '진단용 Git worktree를 준비하지 못했습니다.', remedy: '저장소의 Git 메타데이터 및 임시 디렉터리 쓰기 권한을 확인하세요.', details: { code: signal?.aborted ? 'ABORTED' : 'WORKTREE_UNAVAILABLE' } });
      return report;
    }
    const readyViewers = new Set();
    for (const request of requests) {
      if (signal?.aborted) break;
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
      if (signal?.aborted) {
        await add({ ...base, status: 'FAIL', message: '진단이 취소되었습니다.', remedy: '필요하면 doctor를 다시 실행하세요.', details: { code: 'ABORTED' } });
        continue;
      }
      if (!readyViewers.has(request.criticId)) {
        await add({ ...base, status: 'SKIP', message: 'Artifact Viewer 준비 실패로 실행기 실사용 진단을 수행하지 않았습니다.' });
        continue;
      }
      try {
        if (typeof executors?.probe !== 'function') throw Object.assign(new Error('실행기에 실사용 진단 기능이 없습니다.'), { code: 'PROBE_UNSUPPORTED', remedy: 'probe를 제공하는 실행기를 등록하세요.' });
        const result = await executors.probe(request, { worktreePath, runDir: resolve(scratch, `probe-${index}`), signal, onEvent });
        if (result?.ok !== true) throw Object.assign(new Error(result?.message ?? '실행기 준비 상태를 확인하지 못했습니다.'), { code: 'PROBE_FAILED', remedy: result?.remedy });
        await add({ ...base, status: 'PASS', message: result.message, details: result.details });
      } catch (error) {
        // Unknown adapter failures get a safe generic diagnostic, not raw output.
        await add({ ...base, status: 'FAIL', message: error.code ? bounded(error.message) : '실행기의 실사용 진단을 완료하지 못했습니다.', remedy: error.remedy ?? 'Provider 설정·연결과 실행 환경을 확인한 뒤 다시 진단하세요.', details: { code: typeof error.code === 'string' ? error.code : 'PROBE_FAILED' } });
      }
    }
    const modified = (await git(worktreePath, ['status', '--porcelain', '--untracked-files=no'])).trim();
    const head = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
    if (modified || head !== snapshotCommit.toLowerCase()) await add({ id: 'snapshot-unchanged', status: 'FAIL', kind: 'snapshot', message: '진단 중 스냅샷의 커밋 또는 추적 파일이 변경되었습니다.', remedy: '실행기가 진단 중 프로젝트 파일이나 커밋을 수정하지 않도록 확인하세요.', details: { code: 'SNAPSHOT_CHANGED' } });
  } catch (error) {
    await add({ id: 'diagnostic', status: 'FAIL', message: error.code === 'ABORTED' ? '진단이 취소되었습니다.' : '진단을 완료하지 못했습니다.', remedy: '로컬 실행 환경과 권한을 확인한 뒤 다시 진단하세요.', details: { code: error.code === 'ABORTED' ? 'ABORTED' : 'DIAGNOSTIC_FAILED' } });
  } finally {
    // Interrupted `worktree add` can register a worktree before it rejects.
    if (scratch && !worktreeCreated) {
      try { worktreeCreated = (await git(repoPath, ['worktree', 'list', '--porcelain'])).split('\n').includes(`worktree ${worktreePath}`); } catch {}
    }
    if (worktreeCreated) {
      try { await git(repoPath, ['-c', `core.hooksPath=${hooksPath}`, 'worktree', 'remove', '--force', worktreePath]); }
      catch { await add({ id: 'cleanup', status: 'FAIL', message: '진단용 worktree를 정리하지 못했습니다.', remedy: 'Git worktree 목록에서 ccdd-doctor 임시 경로를 확인하고 정리하세요.', details: { code: 'CLEANUP_FAILED', worktreePath } }); }
    }
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(async () => { await add({ id: 'temporary-cleanup', status: 'FAIL', message: '진단 임시 파일을 정리하지 못했습니다.', remedy: '임시 디렉터리의 쓰기 권한을 확인하세요.', details: { code: 'CLEANUP_FAILED' } }); });
    report.ok = report.checks.length > 0 && report.checks.every(check => check.status === 'PASS');
    report.status = report.ok ? 'READY' : 'NOT_READY';
    report.checkedAt = new Date().toISOString();
  }
  return report;
}
