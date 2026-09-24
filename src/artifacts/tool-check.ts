import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localContext } from '../local.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { prepareWorkspace, type WorkspaceHandle } from '../workspaces/index.js';
import { createReviewTools, type ReviewToolDefinition } from '../tools/runner.js';
import type { ToolResult } from '../tools/contracts.js';
import { assertArtifactAudience, type ArtifactAudience } from './types.js';
import { resolveArtifactScope } from './scope.js';
import { safeToolFailure, toolFailureStage, type ArtifactToolCheckStage } from '../tools/diagnostics.js';

export interface ArtifactToolCheck {
  artifactId?: string;
  audience?: ArtifactAudience;
  toolName?: string;
  ok: boolean;
  message: string;
  code?: string;
  stage: ArtifactToolCheckStage;
}
export interface ArtifactToolCheckReport {
  ok: boolean;
  status: 'READY' | 'NOT_READY';
  checkedAt: string;
  snapshotHash?: string;
  workspacePath?: string;
  outputDir?: string;
  checks: ArtifactToolCheck[];
  tools: Array<ReviewToolDefinition & { audience: ArtifactAudience }>;
  result?: ToolResult;
}
export interface DiagnoseArtifactToolsOptions {
  repoPath: string;
  repoId?: string;
  stateDir?: string;
  artifactId?: string;
  audience?: ArtifactAudience;
  toolName?: string;
  arguments?: unknown;
  execute?: boolean;
  signal?: AbortSignal;
}

/** Diagnose registered tools without creating a Broker, Run, request, alarm, Agent session or verdict. */
export async function diagnoseArtifactTools({ repoPath, stateDir, artifactId, audience, toolName, arguments: args, execute = false, signal, ...removed }: DiagnoseArtifactToolsOptions): Promise<ArtifactToolCheckReport> {
  if ('mode' in removed) throw new Error('Workspace modes are no longer supported; supply an unchanged workspace.');
  const report: ArtifactToolCheckReport = { ok: false, status: 'NOT_READY', checkedAt: new Date().toISOString(), checks: [], tools: [] };
  let workspace: WorkspaceHandle | undefined;
  let stage: ArtifactToolCheckStage = 'preflight';
  try {
    if ((audience !== undefined && audience !== 'agent' && audience !== 'human') || (execute && (!artifactId || !audience || !toolName)) || (!execute && args !== undefined)) throw new Error('Actual tool execution requires explicit Artifact, audience and tool selection.');
    signal?.throwIfAborted();
    stage = 'snapshot';
    const context = await localContext({ repoPath, stateDir });
    workspace = await prepareWorkspace({ repoPath: context.repoPath, stateDir: context.stateDir, signal });
    const worktreePath = workspace.descriptor.path;
    report.snapshotHash = workspace.descriptor.hash;
    // A desktop viewer opens this supplied workspace; keep it unchanged while inspecting it.
    report.workspacePath = worktreePath;
    stage = 'preflight';
    const { config } = await readWorkspaceConfig(worktreePath, workspace.signal);
    const { configManifest } = config;
    if (artifactId !== undefined && !Object.hasOwn(config.artifacts, artifactId)) throw new Error('Unknown selected Artifact.');
    const selectedScope = resolveArtifactScope(config.artifacts, artifactId === undefined ? Object.keys(config.artifacts) : [artifactId]);
    const selected = selectedScope.artifacts;
    if (!selected.length) throw new Error('Unknown selected Artifact.');
    if (!artifactId && !audience && !toolName) {
      for (const critic of config.critics) {
        try {
          assertArtifactAudience({ profile: critic.profile, ...resolveArtifactScope(config.artifacts, [critic.target, ...critic.deps]), requiredObservations: [critic.target, ...critic.deps] });
        } catch (error) {
          report.checks.push({ stage, ok: false, ...safeToolFailure(error) });
        }
      }
    }
    for (const targetAudience of audience ? [audience] : ['agent', 'human'] as const) {
      stage = 'preflight';
      const registry = await createReviewTools({ worktreePath, ...selectedScope, configManifest, audience: targetAudience, runDir: join(context.stateDir, 'tool-check', randomUUID()), signal: workspace.signal });
      if (execute && targetAudience === audience && registry.outputDir) report.outputDir = registry.outputDir;
      try {
        // Explicit Artifact selection makes the short operation name unambiguous; published names win.
        const resolvedToolName = toolName === undefined || registry.tools.some(tool => tool.name === toolName) || artifactId === undefined ? toolName : `${toolName}_${artifactId}`;
        const definitions = registry.tools.filter(tool => resolvedToolName === undefined || tool.name === resolvedToolName);
        if (toolName !== undefined && !definitions.length) {
          report.checks.push({ artifactId, audience: targetAudience, toolName, stage, ok: false, code: 'ARTIFACT_TOOL_NOT_REGISTERED', message: 'The selected tool is not registered for this Artifact and reviewer kind.' });
          continue;
        }
        report.tools.push(...definitions.map(tool => ({ ...tool, audience: targetAudience })));
        for (const artifact of selected) {
          if (toolName !== undefined || registry.tools.some(tool => tool.artifactId === artifact.id)) continue;
          const required = artifactId !== undefined ? audience !== undefined && artifact.id === artifactId : config.critics.some(critic => critic.profile.kind === targetAudience && [critic.target, ...critic.deps].includes(artifact.id));
          report.checks.push({ artifactId: artifact.id, audience: targetAudience, stage, ok: !required, ...(required ? { code: 'ARTIFACT_TOOLS_UNAVAILABLE' } : {}), message: `No ${targetAudience} views are declared for this Artifact.${required ? ' This reviewer requires a view.' : ''}` });
        }
        report.checks.push(...(await registry.preflight({ toolName: resolvedToolName })).map(check => ({ ...check, ...(!check.ok ? safeToolFailure({ code: check.code ?? 'ARTIFACT_TOOL_PREFLIGHT_FAILED' }) : {}), stage: 'preflight' as const, audience: targetAudience })));
        if (execute && targetAudience === audience && definitions.length === 1 && report.checks.every(check => check.ok)) {
          registry.validateArguments(definitions[0].name, args ?? {});
          stage = 'input-integrity';
          await workspace.assertUnchanged();
          stage = 'execute';
          const result = await registry.call(definitions[0].name, args ?? {});
          stage = 'input-integrity';
          await workspace.assertUnchanged();
          report.result = result;
          report.checks.push({ artifactId, audience, toolName: definitions[0].name, stage: 'execute', ok: !result.isError, ...(result.isError ? { code: 'ARTIFACT_TOOL_DOMAIN_ERROR' } : {}), message: result.isError ? 'The selected registered tool returned an author-controlled error. No review result was created.' : 'The selected registered tool completed successfully. No review result was created.' });
        }
      } finally {
        try { await registry.close(); }
        catch (error) { report.checks.push({ artifactId, audience: targetAudience, toolName, stage, ok: false, ...safeToolFailure(error) }); }
      }
    }
    stage = 'input-integrity';
    await workspace.assertUnchanged();
  } catch (error) {
    delete report.result;
    // A mutated workspace can abort a running program before its boundary check resumes.
    // Preserve that integrity failure instead of relabeling it as an ordinary cancellation.
    const reason = workspace?.signal.aborted && !signal?.aborted ? workspace.signal.reason : error;
    report.checks.push({ artifactId, audience, toolName, stage: toolFailureStage(reason, stage), ok: false, ...safeToolFailure(reason, signal?.aborted ?? false) });
  } finally {
    try { await workspace?.close(); }
    catch { report.checks.push({ stage: 'input-integrity', ok: false, code: 'WORKSPACE_CLEANUP_FAILED', message: 'Could not finish workspace observation cleanup.' }); }
    report.ok = report.checks.length > 0 && report.checks.every(check => check.ok);
    if (!report.ok) delete report.result;
    report.status = report.ok ? 'READY' : 'NOT_READY';
    report.checkedAt = new Date().toISOString();
  }
  return report;
}
