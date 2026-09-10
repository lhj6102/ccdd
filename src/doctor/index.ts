import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareReviewRequests } from '../requester/index.js';
import { prepareWorkspace, removeOwnedWorkspaceTree } from '../workspaces/index.js';
import { createArtifactViewer, createArtifactTools, type ArtifactListResult } from '../artifacts/index.js';
import { createHumanArtifactTools } from '../artifacts/human.js';
import { createReviewTools } from '../tools/runner.js';
import { errorCode, errorMessage } from '../executors/errors.js';
import type { ReviewEnvelope, ExecutorRegistry, ExecutionEvent, WorkspaceHandle, WorkspaceMode } from '../contracts.js';


export type DiagnosticScope = { kind: 'graph' } | { kind: 'critic'; criticId: string };
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
const scopeFor = (criticId?: string): DiagnosticScope => criticId === undefined ? { kind: 'graph' } : { kind: 'critic', criticId };
const bounded = (value: unknown): string => String(value).slice(0, 2_000);
const remedyFor = (value: unknown): string | undefined => value && typeof value === 'object' && 'remedy' in value && typeof value.remedy === 'string' ? value.remedy : undefined;

async function inspectViewers(request: ReviewEnvelope, worktreePath: string, signal?: AbortSignal, runDir?: string) {
  if (request.configManifest) {
    // Runtime has its own path/startup contract and requires no Agent/Human tools.
    if (request.profile.kind === 'runtime') return { toolNames: [], toolsExecuted: false, artifactPathsVerified: true };
    const registry = await createReviewTools({ worktreePath, artifacts: request.artifacts, artifactGroups: request.artifactGroups, artifactTypes: request.artifactTypes, configManifest: request.configManifest, criticId: request.criticId, audience: request.profile.kind, signal, runDir });
    try {
      const checks = await registry.preflight();
      const failed = checks.filter(check => !check.ok);
      if (failed.length) throw new Error(failed.map(check => `${check.toolName}: ${check.message}`).join('; '));
      return { toolNames: registry.tools.map(tool => tool.name), checks, toolsExecuted: false, programsLaunched: false };
    } finally { await registry.close(); }
  }
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
    if (signal?.aborted) throw Object.assign(new Error('The diagnostic was cancelled.'), { code: 'ABORTED' });
    try { await executors.validateWorkspace?.(repoPath); }
    catch (error) {
      await add({ id: 'workspace-preflight', status: 'FAIL', kind: 'workspace', message: errorCode(error) ? bounded(errorMessage(error)) : 'Could not verify diagnostic input preconditions.', remedy: remedyFor(error) ?? 'Check that authentication files and execution state paths are outside the review workspace.', details: { code: errorCode(error) ?? 'WORKSPACE_PREFLIGHT_FAILED' } });
      return report;
    }
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-doctor-')));
    try {
      workspace = await prepareWorkspace({ repoPath, stateDir: stateDir ?? join(scratch, 'state'), mode, signal });
      report.snapshotHash = workspace.descriptor.hash;
      await add({ id: 'workspace-input', status: 'PASS', kind: 'workspace', message: mode === 'copy' ? 'Prepared an immutable copy of the entire current repository as diagnostic input.' : 'Started monitoring the entire current workspace for changes.', details: { mode, snapshotHash: report.snapshotHash } });
    } catch (error) {
      await add({ id: 'workspace-input', status: 'FAIL', kind: 'workspace', message: bounded(errorMessage(error)), remedy: 'Check repository read permissions and the external CCDD state path. Keep inputs unchanged while copying.', details: { code: signal?.aborted ? 'ABORTED' : errorCode(error) ?? 'WORKSPACE_UNAVAILABLE' } });
      return report;
    }
    const worktreePath = workspace.descriptor.path;
    let requests: ReviewEnvelope[];
    try {
      requests = await prepareReviewRequests({ repoPath: worktreePath, repoId, snapshotHash: workspace.descriptor.hash, criticId });
      await workspace.assertUnchanged();
      await add({ id: 'workspace-config', status: 'PASS', kind: 'workspace', criticIds: requests.map(x => x.criticId), message: 'Verified the current workspace configuration and Artifact definitions.' });
    } catch (error) {
      await add({ id: 'workspace-config', status: 'FAIL', kind: 'workspace', message: bounded(errorMessage(error)), remedy: 'Check the current ccdd.config.ts or legacy ccdd.config.json, Artifact paths, and Critic IDs.', details: { code: errorCode(error) ?? 'WORKSPACE_CONFIG_INVALID' } });
      return report;
    }
    const readyViewers = new Set<string>();
    for (const request of requests) {
      if (workspace.signal.aborted) break;
      try {
        const details = await inspectViewers(request, worktreePath, workspace.signal, resolve(scratch, `tools-${request.criticId}`));
        readyViewers.add(request.criticId);
        await add({ id: `artifacts:${request.criticId}`, status: 'PASS', kind: 'artifacts', criticIds: [request.criticId], message: request.configManifest ? 'Verified registered Artifact tool manifests and execution readiness. Use tools check --execute to verify actual tool execution separately.' : request.profile.kind === 'human' ? 'Verified Human Artifact tool registration and execution readiness. No programs were launched.' : 'Verified the snapshot Artifact Viewer list and read entry points.', details });
      } catch (error) {
        await add({ id: `artifacts:${request.criticId}`, status: 'FAIL', kind: 'artifacts', criticIds: [request.criticId], message: bounded(errorMessage(error)), remedy: 'Check Artifact paths, types, contents, and read permissions.', details: { code: 'ARTIFACT_VIEWER_UNAVAILABLE' } });
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
        await add({ ...base, status: 'FAIL', message: 'The diagnostic was cancelled.', remedy: 'Run doctor again if needed.', details: { code: 'ABORTED' } });
        continue;
      }
      if (!readyViewers.has(request.criticId)) {
        await add({ ...base, status: 'SKIP', message: 'Skipped the live executor diagnostic because Artifact Viewer preparation failed.' });
        continue;
      }
      try {
        if (typeof executors?.probe !== 'function') throw Object.assign(new Error('The executor does not support live diagnostics.'), { code: 'PROBE_UNSUPPORTED', remedy: 'Register an executor that provides probe.' });
        const result = await executors.probe(request, { worktreePath, workspacePath: worktreePath, runDir: resolve(scratch, `probe-${index}`), signal: workspace.signal, onEvent });
        if (result?.ok !== true) throw Object.assign(new Error(result?.message ?? 'Could not verify executor readiness.'), { code: 'PROBE_FAILED', remedy: result?.remedy });
        await add({ ...base, status: 'PASS', message: result.message, details: result.details });
      } catch (error) {
        // Unknown adapter failures get a safe generic diagnostic, not raw output.
        await add({ ...base, status: 'FAIL', message: errorCode(error) ? bounded(errorMessage(error)) : 'Could not complete the live executor diagnostic.', remedy: remedyFor(error) ?? 'Check Provider settings, connectivity, and the execution environment, then rerun the diagnostic.', details: { code: errorCode(error) ?? 'PROBE_FAILED' } });
      }
    }
    await workspace.assertUnchanged();
  } catch (error) {
    const code = errorCode(error) ?? (signal?.aborted ? 'ABORTED' : 'DIAGNOSTIC_FAILED');
    const changed = ['WORKSPACE_CHANGED', 'WORKSPACE_CACHE_TAMPERED'].includes(code);
    await add({ id: changed ? 'workspace-unchanged' : 'diagnostic', status: 'FAIL', kind: 'workspace', message: changed ? 'Review inputs changed during the diagnostic.' : code === 'ABORTED' ? 'The diagnostic was cancelled.' : 'Could not complete the diagnostic.', remedy: changed ? 'Rerun doctor while keeping diagnostic inputs unchanged.' : 'Check the local execution environment and permissions, then rerun the diagnostic.', details: { code } });
  } finally {
    if (workspace) {
      try { await workspace.close(); }
      catch (error) { await add({ id: 'workspace-cleanup', status: 'FAIL', message: 'Could not clean up diagnostic workspace monitoring.', remedy: 'Check permissions on the CCDD state path.', details: { code: errorCode(error) ?? 'CLEANUP_FAILED' } }); }
    }
    if (scratch) {
      try { await removeOwnedWorkspaceTree(scratch); }
      catch { await add({ id: 'temporary-cleanup', status: 'FAIL', message: 'Could not clean up temporary diagnostic files.', remedy: 'Check write permissions on the temporary directory.', details: { code: 'CLEANUP_FAILED' } }); }
    }
    report.ok = report.checks.length > 0 && report.checks.every(check => check.status === 'PASS');
    report.status = report.ok ? 'READY' : 'NOT_READY';
    report.checkedAt = new Date().toISOString();
  }
  return report;
}
