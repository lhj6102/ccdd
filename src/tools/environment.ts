import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesToolManifest, scopeToolManifest } from './manifest.js';
import type { ConfigManifest } from './contracts.js';
import { readArtifactConfig } from '../broker/config.js';
import { scopedPath, within } from './paths.js';

export interface EnvironmentCheck { id: string; ok: boolean; message: string }
export interface EnvironmentCheckResult { ok: boolean; checks: EnvironmentCheck[] }
export interface EnvironmentCheckOptions { workspacePath: string; configManifest?: ConfigManifest; outputDir: string; signal?: AbortSignal; artifactIds?: readonly string[] }

export async function environmentOutputDirectory(root: string, directory: string): Promise<string> {
  const target = resolve(directory);
  let ancestor = target;
  while (true) {
    const actual = await realpath(ancestor).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (actual !== undefined) {
      if (within(root, actual) || within(root, target)) throw new Error('Environment check output must be outside reviewed input.');
      break;
    }
    ancestor = dirname(ancestor);
  }
  await mkdir(target, { recursive: true });
  return realpath(target);
}

/** Checks inspect the reviewer's installed environment without inheriting Provider credentials or Node preload hooks. */
function checkEnvironment(outputDir: string, tmpDir: string): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
  return {
    ...Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!] ])),
    CCDD_OUTPUT_DIR: outputDir, CCDD_TMP_DIR: tmpDir, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir,
    XDG_CACHE_HOME: join(tmpDir, 'cache'), CARGO_TARGET_DIR: join(outputDir, 'cargo-target'),
  };
}

/** Shared bounded executor for readiness and owner identity scripts. Callers enforce workspace integrity. */
export function runEnvironmentScript({ command, args, cwd, outputDir, tmpDir, signal, timeoutMs = 30000, label = 'Environment check', description = 'Environment check passed.' }: {
  command: string; args: string[]; cwd: string; outputDir: string; tmpDir: string; signal?: AbortSignal;
  timeoutMs?: number; label?: string; description?: string;
}): Promise<{ ok: boolean; message: string; stdout: string }> {
  signal?.throwIfAborted();
  return new Promise(resolveCheck => {
    const child = spawn(command, args, {
      cwd, env: checkEnvironment(outputDir, tmpDir), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks: Buffer[] = [], stdout: Buffer[] = [];
    let bytes = 0, retained = 0, settled = false, failure: string | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals): void => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Already exited. */ } };
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const diagnostic = Buffer.concat(chunks).toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
      resolveCheck({ ok, message: `${message}${label === 'Environment check' && diagnostic ? `\n${diagnostic}` : ''}`.slice(0, 4000), stdout: Buffer.concat(stdout).toString('utf8') });
    };
    const stop = (message: string): void => {
      if (settled || failure) return;
      failure = message; kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(false, message); }, 500);
    };
    const abort = (): void => stop(`${label} was cancelled.`);
    const timer = setTimeout(() => stop(`${label} timed out after ${timeoutMs} ms.`), timeoutMs);
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (retained < 8192) { const part = chunk.subarray(0, 8192 - retained); chunks.push(part); retained += part.length; }
      if (bytes > 65536) stop(`${label} output exceeded 64 KiB.`);
    };
    child.stdout.on('data', (chunk: Buffer) => { if (bytes < 65536) stdout.push(chunk.subarray(0, 65536 - bytes)); capture(chunk); }); child.stderr.on('data', capture);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { kill('SIGKILL'); finish(false, failure ?? `${label} could not be started.`); });
    // A readiness check may not leave a background process after its script exits.
    child.on('exit', () => kill('SIGKILL'));
    child.on('close', code => finish(!failure && code === 0, failure ?? (code === 0 ? description : `${label} failed (exit ${code ?? 'signal'}): ${description}`)));
    if (signal?.aborted) abort();
  });
}

/** Explicit Human claim preparation only. The caller owns workspace integrity checks and the Try Claim lease. */
export async function checkEnvironmentRequirements(options: EnvironmentCheckOptions): Promise<EnvironmentCheckResult> {
  options.signal?.throwIfAborted();
  if (options.configManifest?.envRequirements === undefined) return { ok: true, checks: [] };
  const manifest = scopeToolManifest(options.configManifest, options.artifactIds ?? Object.keys(options.configManifest.artifacts));
  const requirements = manifest.envRequirements ?? {};
  const root = await realpath(options.workspacePath);
  // Reconnect declarations from this exact snapshot before executing any stored script path.
  const mismatch = () => Object.assign(new Error('Recorded environment requirements do not match this snapshot configuration.'), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
  const { config } = await readArtifactConfig(root, manifest.artifacts, undefined, options.signal).catch(error => { options.signal?.throwIfAborted(); throw Object.assign(mismatch(), { cause: error }); });
  if (!matchesToolManifest(config, manifest)) throw mismatch();
  const base = await environmentOutputDirectory(root, options.outputDir), checks: EnvironmentCheck[] = [];
  for (const [id, requirement] of Object.entries(requirements)) {
    if (options.artifactIds && !options.artifactIds.includes(id.split('/')[0])) continue;
    options.signal?.throwIfAborted();
    const outputDir = await environmentOutputDirectory(root, join(base, id)), tmpDir = await environmentOutputDirectory(root, join(outputDir, '.tmp'));
    const { ok, message } = await runEnvironmentScript({ command: process.execPath,
      args: [fileURLToPath(new URL('./environment-host.js', import.meta.url)), root, await scopedPath(root, requirement.script)],
      cwd: root, outputDir, tmpDir, signal: options.signal, timeoutMs: requirement.timeoutMs, description: requirement.description });
    options.signal?.throwIfAborted();
    checks.push({ id, ok, message });
  }
  return { ok: checks.every(check => check.ok), checks };
}
