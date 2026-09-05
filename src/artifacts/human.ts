import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { createArtifactViewer, createArtifactTools, validateToolArguments, type ArtifactCallResult, type ArtifactToolDefinition, type ArtifactViewerOptions } from './index.js';
import { artifactAudienceTools, type HumanCommandTool } from './types.js';

export interface HumanToolDefinition extends Omit<ArtifactToolDefinition, 'operation' | 'annotations' | 'artifactId'> {
  artifactId: string;
  operation: 'read' | 'list' | 'command';
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export interface HumanLaunchResult {
  kind: 'launch';
  artifactId: string;
  toolName: string;
  launched: true;
  message: string;
}
export type HumanToolResult = ArtifactCallResult | HumanLaunchResult;
export interface HumanToolCheck { toolName: string; artifactId: string; ok: boolean; message: string }
export interface HumanArtifactTools {
  readonly tools: HumanToolDefinition[];
  validateArguments(name: string, args: unknown): Record<string, unknown>;
  call(name: string, args?: unknown): Promise<HumanToolResult>;
  preflight(options?: { toolName?: string }): Promise<HumanToolCheck[]>;
}
export interface HumanArtifactToolsOptions extends ArtifactViewerOptions { allowLegacy?: boolean }

function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }

async function executablePath(command: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).filter(entry => isAbsolute(entry)).map(entry => join(entry, command));
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      signal?.throwIfAborted();
      return candidate;
    } catch { signal?.throwIfAborted(); }
  }
  throw failure('HUMAN_TOOL_UNAVAILABLE', 'The registered Human tool executable is unavailable. Install it or update the registered type configuration.');
}

/** Do not forward Provider secrets as environment variables to desktop programs. */
function desktopEnvironment(): NodeJS.ProcessEnv {
  const keys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'];
  return Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
}

/** Execute a trusted registered argv directly. Output and raw launch errors never leave this boundary. */
function launch(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure('ABORTED', 'Human tool execution was cancelled.')); return; }
    const child = spawn(command, args, { cwd, env: desktopEnvironment(), shell: false, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
    let terminal = false;
    let stopping: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals): void => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    const finish = (error?: Error): void => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const stop = (error: Error): void => {
      if (stopping || terminal) return;
      stopping = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(error); }, 500);
      killTimer.unref();
    };
    const abort = (): void => stop(failure('ABORTED', 'Human tool execution was cancelled.'));
    const timer = setTimeout(() => stop(failure('HUMAN_TOOL_TIMEOUT', `Human tool execution exceeded ${timeoutMs} ms.`)), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { if (stopping) kill('SIGKILL'); finish(stopping ?? failure('HUMAN_TOOL_UNAVAILABLE', 'The registered Human tool could not be started.')); });
    // The launcher may exit on SIGTERM while descendants ignore it. Kill the remaining
    // group before clearing the escalation timer, including this early-close path.
    child.on('close', code => { if (stopping) kill('SIGKILL'); finish(stopping ?? (code === 0 ? undefined : failure('HUMAN_TOOL_FAILED', 'The registered Human tool did not finish successfully. Check the program and its registered arguments.'))); });
    // The signal may have changed while creating the process and registering the listener.
    if (signal?.aborted) abort();
  });
}

/** Construct Human capabilities from the registered snapshot configuration; creating/listing never launches an app. */
export async function createHumanArtifactTools({ allowLegacy = false, ...options }: HumanArtifactToolsOptions): Promise<HumanArtifactTools> {
  const viewer = await createArtifactViewer(options);
  const builtins = createArtifactTools(viewer, { audience: 'human', allowLegacy });
  const definitions: HumanToolDefinition[] = [];
  const registered = new Map<string, { definition: HumanToolDefinition; command?: HumanCommandTool }>();
  const insert = (definition: HumanToolDefinition, command?: HumanCommandTool): void => {
    if (registered.has(definition.name)) throw failure('ARTIFACT_TOOL_NAME_COLLISION', 'Registered Human tool names collide across Artifacts. Rename the tool or Artifact.');
    definitions.push(definition);
    registered.set(definition.name, { definition, ...(command ? { command } : {}) });
  };
  for (const tool of builtins.tools) insert({ ...tool, artifactId: tool.artifactId!, operation: tool.operation! });
  for (const artifact of viewer.listArtifacts()) {
    const configured = artifactAudienceTools(viewer.getTypeDefinition(artifact.id), 'human', { allowLegacy });
    for (const [key, tool] of Object.entries(configured)) {
      if (!('command' in tool)) continue;
      insert({
        artifactId: artifact.id, operation: 'command', name: `${key}_${artifact.id}`,
        description: tool.description.replaceAll('{artifactName}', () => artifact.id),
        inputSchema: { type: 'object', properties: artifact.directory ? { path: { type: 'string', description: 'Optional relative path inside this Artifact. Omit to open the Artifact root.' } } : {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      }, structuredClone(tool));
    }
  }
  const entryFor = (name: string) => {
    const entry = registered.get(name);
    if (!entry) throw failure('UNKNOWN_ARTIFACT_TOOL', 'Unknown registered Human artifact tool.');
    return entry;
  };
  const validateArguments = (name: string, args: unknown): Record<string, unknown> => validateToolArguments(entryFor(name).definition.inputSchema, args);
  return {
    get tools() { return structuredClone(definitions); },
    validateArguments,
    async call(name, args: unknown = {}) {
      const { definition, command } = entryFor(name);
      const actualArgs = structuredClone(validateArguments(name, args));
      viewer.signal?.throwIfAborted();
      if (!command) return builtins.call(name, actualArgs);
      const target = await viewer.resolveTarget(definition.artifactId, actualArgs.path as string | undefined);
      const executable = await executablePath(command.command, viewer.signal);
      await launch(executable, command.args.map(arg => arg === '{artifactPath}' ? target.absolutePath : arg), target.directory ? target.absolutePath : dirname(target.absolutePath), command.timeoutMs ?? 10_000, viewer.signal);
      viewer.signal?.throwIfAborted();
      return { kind: 'launch', artifactId: definition.artifactId, toolName: definition.name, launched: true, message: 'The registered program finished successfully. This does not confirm that a person read the Artifact or completed the review.' };
    },
    async preflight({ toolName } = {}) {
      if (toolName !== undefined) entryFor(toolName);
      const checks: HumanToolCheck[] = [];
      for (const { definition, command } of registered.values()) {
        if (toolName !== undefined && definition.name !== toolName) continue;
        viewer.signal?.throwIfAborted();
        try {
          await viewer.resolveTarget(definition.artifactId);
          if (command) await executablePath(command.command, viewer.signal);
          checks.push({ toolName: definition.name, artifactId: definition.artifactId, ok: true, message: command ? 'The registered executable and Artifact are available. No program was launched.' : 'The registered Viewer operation and Artifact are available.' });
        } catch {
          viewer.signal?.throwIfAborted();
          checks.push({ toolName: definition.name, artifactId: definition.artifactId, ok: false, message: 'The registered tool or Artifact is unavailable. Check the type configuration and installed program.' });
        }
      }
      return checks;
    },
  };
}
