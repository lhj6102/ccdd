import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localContext } from '../local.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace, type WorkspaceHandle, type WorkspaceMode } from '../workspaces/index.js';
import type { HumanToolResult } from './human.js';
import { createReviewTools, type ReviewToolDefinition } from '../tools/runner.js';
import type { ToolResult } from '../tools/contracts.js';
import { assertArtifactAudience, type ArtifactAudience } from './types.js';
import { isArtifactGroup, resolveArtifactScope } from './groups.js';

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
  tools: Array<ReviewToolDefinition & { audience: ArtifactAudience }>;
  result?: HumanToolResult | ToolResult;
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
    const { configManifest } = config;
    if (artifactId !== undefined && !Object.hasOwn(config.artifacts, artifactId)) throw new Error('Unknown selected Artifact.');
    if (execute && artifactId !== undefined && isArtifactGroup(config.artifacts[artifactId])) {
      report.checks.push({ artifactId, ok: false, message: 'Groups collect member tools. Select a leaf Artifact with --artifact to execute its tool.' });
      return report;
    }
    const selectedScope = resolveArtifactScope(config.artifacts, artifactId === undefined ? Object.keys(config.artifacts) : [artifactId]);
    const selected = selectedScope.artifacts;
    if (!selected.length) throw new Error('Unknown selected Artifact.');
    if (!artifactId && !audience && !toolName) {
      for (const critic of config.critics) {
        try {
          assertArtifactAudience({ profile: critic.profile, ...resolveArtifactScope(config.artifacts, [critic.target, ...critic.deps]), artifactTypes: config.artifactTypes, configManifest });
        } catch (error) {
          report.checks.push({ ok: false, ...safeFailure(error, false) });
        }
      }
    }
    for (const targetAudience of audience ? [audience] : ['agent', 'human'] as const) {
      const registry = await createReviewTools({ worktreePath, ...selectedScope, artifactTypes: config.artifactTypes, configManifest, audience: targetAudience, runDir: join(context.stateDir, 'tool-check', randomUUID()), signal: workspace.signal });
      try {
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
          const required = audience !== undefined || config.critics.some(critic => critic.profile.kind === targetAudience && resolveArtifactScope(config.artifacts, [critic.target, ...critic.deps]).artifacts.some(leaf => leaf.id === artifact.id));
          report.checks.push({ artifactId: artifact.id, audience: targetAudience, ok: !required, message: `No ${targetAudience} tools are available for this Artifact. It cannot be used by a ${targetAudience} Critic.` });
        }
        report.checks.push(...(await registry.preflight({ toolName: resolvedToolName })).map(check => ({ ...check, audience: targetAudience })));
        if (execute && targetAudience === audience && definitions.length === 1 && report.checks.every(check => check.ok)) {
          await workspace.assertUnchanged();
          const result = await registry.call(definitions[0].name, args ?? {});
          await workspace.assertUnchanged();
          report.result = result;
          report.checks.push({ artifactId, audience, toolName: definitions[0].name, ok: true, message: 'The selected registered tool completed successfully. No review result was created.' });
        }
      } finally { await registry.close(); }
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
