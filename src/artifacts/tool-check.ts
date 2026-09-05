import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { localContext } from '../local.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace, type WorkspaceHandle, type WorkspaceMode } from '../workspaces/index.js';
import { createArtifactViewer, createArtifactTools, type ArtifactToolDefinition } from './index.js';
import { createHumanArtifactTools, type HumanToolDefinition, type HumanToolResult } from './human.js';
import { assertArtifactAudience, type ArtifactAudience } from './types.js';

export interface ArtifactToolCheck {
  artifactId?: string;
  audience?: ArtifactAudience;
  toolName?: string;
  ok: boolean;
  message: string;
  code?: string;
}
export interface ArtifactToolCheckReport {
  ok: boolean;
  status: 'READY' | 'NOT_READY';
  mode: WorkspaceMode;
  checkedAt: string;
  snapshotHash?: string;
  workspacePath?: string;
  checks: ArtifactToolCheck[];
  tools: Array<(ArtifactToolDefinition | HumanToolDefinition) & { audience: ArtifactAudience }>;
  result?: HumanToolResult;
}
export interface DiagnoseArtifactToolsOptions {
  repoPath: string;
  repoId?: string;
  mode?: WorkspaceMode;
  stateDir?: string;
  artifactId?: string;
  audience?: ArtifactAudience;
  toolName?: string;
  arguments?: unknown;
  execute?: boolean;
  signal?: AbortSignal;
}

function safeFailure(error: unknown, aborted: boolean): { code: string; message: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (aborted || code === 'ABORTED') return { code: 'ABORTED', message: 'Artifact tool diagnosis was cancelled.' };
  if (code === 'WORKSPACE_CHANGED' || code === 'WORKSPACE_CACHE_TAMPERED') return { code, message: 'The workspace changed during Artifact tool diagnosis.' };
  if (code === 'ARTIFACT_TOOLS_UNAVAILABLE') return { code, message: 'A Critic references an Artifact with no tools for its reviewer kind. Register the corresponding agentTools or humanTools.' };
  if (code === 'HUMAN_TOOL_TIMEOUT') return { code, message: 'The registered Human tool exceeded its configured time limit.' };
  if (code === 'HUMAN_TOOL_UNAVAILABLE') return { code, message: 'The registered Human tool executable is unavailable.' };
  if (code === 'HUMAN_TOOL_FAILED') return { code, message: 'The registered Human tool did not finish successfully.' };
  return { code: 'ARTIFACT_TOOL_CHECK_FAILED', message: 'Artifact tool diagnosis failed. Check the configuration, selected tool, scoped arguments and workspace access.' };
}

/** Diagnose registered tools without creating a Broker, Run, request, alarm, Agent session or verdict. */
export async function diagnoseArtifactTools({ repoPath, mode = 'copy', stateDir, artifactId, audience, toolName, arguments: args, execute = false, signal }: DiagnoseArtifactToolsOptions): Promise<ArtifactToolCheckReport> {
  const report: ArtifactToolCheckReport = { ok: false, status: 'NOT_READY', mode, checkedAt: new Date().toISOString(), checks: [], tools: [] };
  let workspace: WorkspaceHandle | undefined;
  try {
    if ((audience !== undefined && audience !== 'agent' && audience !== 'human') || (execute && (!artifactId || !audience || !toolName)) || (!execute && args !== undefined)) throw new Error('Actual tool execution requires explicit Artifact, audience and tool selection.');
    signal?.throwIfAborted();
    const context = await localContext({ repoPath, stateDir });
    workspace = await prepareWorkspace({ repoPath: context.repoPath, stateDir: context.stateDir, mode, signal });
    const worktreePath = workspace.descriptor.path;
    report.snapshotHash = workspace.descriptor.hash;
    // Cached copies are retained: a desktop viewer can continue reading after its launcher exits.
    report.workspacePath = worktreePath;
    const { config } = await readWorkspaceConfig(worktreePath);
    const allArtifacts = Object.entries(config.artifacts).map(([id, value]) => ({ id, ...value }));
    const selected = artifactId === undefined ? allArtifacts : allArtifacts.filter(artifact => artifact.id === artifactId);
    if (!selected.length) throw new Error('Unknown selected Artifact.');
    if (!artifactId && !audience && !toolName) {
      for (const critic of config.critics) {
        try {
          assertArtifactAudience({ profile: critic.profile, artifacts: allArtifacts.filter(artifact => critic.artifacts.includes(artifact.id)), artifactTypes: config.artifactTypes });
        } catch (error) {
          report.checks.push({ ok: false, ...safeFailure(error, false) });
        }
      }
    }
    for (const targetAudience of audience ? [audience] : ['agent', 'human'] as const) {
      const options = { worktreePath, artifacts: selected, artifactTypes: config.artifactTypes, signal: workspace.signal };
      const viewer = await createArtifactViewer(options);
      const registry = targetAudience === 'human' ? await createHumanArtifactTools(options) : createArtifactTools(viewer, { allowLegacy: false });
      // Explicit Artifact selection makes the short operation name unambiguous; published names win.
      const resolvedToolName = toolName === undefined || registry.tools.some(tool => tool.name === toolName) || artifactId === undefined ? toolName : `${toolName}_${artifactId}`;
      const definitions = registry.tools.filter(tool => resolvedToolName === undefined || tool.name === resolvedToolName);
      if (toolName !== undefined && !definitions.length) {
        report.checks.push({ artifactId, audience: targetAudience, toolName, ok: false, message: 'The selected tool is not registered for this Artifact and reviewer kind.' });
        continue;
      }
      report.tools.push(...definitions.map(tool => ({ ...tool, audience: targetAudience })));
      for (const artifact of selected) {
        if (definitions.some(tool => tool.artifactId === artifact.id)) continue;
        const required = audience !== undefined || config.critics.some(critic => critic.profile.kind === targetAudience && critic.artifacts.includes(artifact.id));
        report.checks.push({ artifactId: artifact.id, audience: targetAudience, ok: !required, message: `No ${targetAudience} tools are available for this Artifact. It cannot be used by a ${targetAudience} Critic.` });
      }
      if (targetAudience === 'human' && 'preflight' in registry) {
        report.checks.push(...(await registry.preflight({ toolName: resolvedToolName })).map(check => ({ ...check, audience: targetAudience })));
      } else {
        for (const tool of definitions) {
          try {
            const target = await viewer.resolveTarget(tool.artifactId!);
            await access(target.absolutePath, constants.R_OK);
            report.checks.push({ artifactId: tool.artifactId, audience: targetAudience, toolName: tool.name, ok: true, message: 'The registered Viewer operation and Artifact are available. No tool was called.' });
          } catch {
            workspace.signal.throwIfAborted();
            report.checks.push({ artifactId: tool.artifactId, audience: targetAudience, toolName: tool.name, ok: false, message: 'The registered Artifact is unavailable.' });
          }
        }
      }
      if (execute && targetAudience === audience && definitions.length === 1 && report.checks.every(check => check.ok)) {
        await workspace.assertUnchanged();
        const result = await registry.call(definitions[0].name, args ?? {});
        await workspace.assertUnchanged();
        report.result = result;
        report.checks.push({ artifactId, audience, toolName: definitions[0].name, ok: true, message: 'The selected registered tool completed successfully. No review result was created.' });
      }
    }
    await workspace.assertUnchanged();
  } catch (error) {
    delete report.result;
    // A mutated workspace can abort a running program before its boundary check resumes.
    // Preserve that integrity failure instead of relabeling it as an ordinary cancellation.
    const reason = workspace?.signal.aborted && !signal?.aborted ? workspace.signal.reason : error;
    report.checks.push({ artifactId, audience, toolName, ok: false, ...safeFailure(reason, signal?.aborted ?? false) });
  } finally {
    try { await workspace?.close(); }
    catch { report.checks.push({ ok: false, code: 'WORKSPACE_CLEANUP_FAILED', message: 'Could not finish workspace observation cleanup.' }); }
    report.ok = report.checks.length > 0 && report.checks.every(check => check.ok);
    report.status = report.ok ? 'READY' : 'NOT_READY';
    report.checkedAt = new Date().toISOString();
  }
  return report;
}
