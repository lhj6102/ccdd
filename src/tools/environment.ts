import { spawn } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ConfigManifest, EnvironmentRequirement } from './contracts.js';
import { openToolHost } from './host.js';
import { environmentRequirements } from './schema.js';
import { scopedPath, within } from './paths.js';

export interface EnvironmentCheck { id: string; ok: boolean; message: string }
export interface EnvironmentCheckResult { ok: boolean; checks: EnvironmentCheck[] }
export interface EnvironmentCheckOptions { workspacePath: string; configManifest?: ConfigManifest; outputDir: string; signal?: AbortSignal }

async function outputDirectory(root: string, directory: string): Promise<string> {
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

function runCheck(root: string, script: string, requirement: EnvironmentRequirement, outputDir: string, tmpDir: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  signal?.throwIfAborted();
  const timeoutMs = requirement.timeoutMs ?? 30000;
  return new Promise(resolveCheck => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./environment-host.js', import.meta.url)), root, script], {
      cwd: root, env: checkEnvironment(outputDir, tmpDir), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0, retained = 0, settled = false, failure: string | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals): void => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind); } catch { /* Already exited. */ } };
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      const diagnostic = Buffer.concat(chunks).toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
      resolveCheck({ ok, message: `${message}${diagnostic ? `\n${diagnostic}` : ''}`.slice(0, 4000) });
    };
    const stop = (message: string): void => {
      if (settled || failure) return;
      failure = message; kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(false, message); }, 500);
    };
    const abort = (): void => stop('Environment check was cancelled.');
    const timer = setTimeout(() => stop(`Environment check timed out after ${timeoutMs} ms.`), timeoutMs);
    const capture = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (retained < 8192) { const part = chunk.subarray(0, 8192 - retained); chunks.push(part); retained += part.length; }
      if (bytes > 65536) stop('Environment check output exceeded 64 KiB.');
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => { kill('SIGKILL'); finish(false, failure ?? 'The environment check could not be started.'); });
    // A readiness check may not leave a background process after its script exits.
    child.on('exit', () => kill('SIGKILL'));
    child.on('close', code => finish(!failure && code === 0, failure ?? (code === 0 ? requirement.description : `Environment check failed (exit ${code ?? 'signal'}): ${requirement.description}`)));
    if (signal?.aborted) abort();
  });
}

/** Explicit Human claim preparation only. The caller owns workspace integrity checks and the Try Claim lease. */
export async function checkEnvironmentRequirements(options: EnvironmentCheckOptions): Promise<EnvironmentCheckResult> {
  options.signal?.throwIfAborted();
  if (options.configManifest?.envRequirements === undefined) return { ok: true, checks: [] };
  const requirements = environmentRequirements(options.configManifest.envRequirements);
  const root = await realpath(options.workspacePath);
  // Reconnect declarations from this exact snapshot before executing any stored script path.
  const host = await openToolHost(root, options.signal).catch(error => { options.signal?.throwIfAborted(); throw error; });
  try {
    if (!isDeepStrictEqual(host.config.configManifest, options.configManifest)) throw Object.assign(new Error('Recorded environment requirements do not match this snapshot configuration.'), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
  } finally { await host.close(); }
  const base = await outputDirectory(root, options.outputDir), checks: EnvironmentCheck[] = [];
  for (const [id, requirement] of Object.entries(requirements)) {
    options.signal?.throwIfAborted();
    const outputDir = await outputDirectory(root, join(base, id)), tmpDir = await outputDirectory(root, join(outputDir, '.tmp'));
    const result = await runCheck(root, await scopedPath(root, requirement.script), requirement, outputDir, tmpDir, options.signal);
    options.signal?.throwIfAborted();
    checks.push({ id, ...result });
  }
  return { ok: checks.every(check => check.ok), checks };
}
