import { spawn } from 'node:child_process';

interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  capture?: boolean;
  maxOutputBytes?: number;
}

/** Never forward arbitrary environment variables, including Provider credentials or NODE_OPTIONS. */
export function toolEnvironment(tmpDir: string, desktop = false): NodeJS.ProcessEnv {
  const names = desktop
    ? ['PATH', 'HOME', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR']
    : ['LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'];
  return { ...Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])), TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir };
}

/** Kill the complete launcher group on cancellation, including children surviving their parent. */
export function runToolProcess(command: string, args: string[], options: ProcessOptions): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, shell: false, detached: process.platform !== 'win32',
      stdio: options.capture === false ? ['pipe', 'ignore', 'ignore'] : ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false, failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const stop = (error: Error): void => {
      if (settled || failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(error); }, 500);
      killTimer.unref();
    };
    const abort = (): void => stop(new Error('Artifact tool execution aborted'));
    const timer = setTimeout(() => stop(new Error(`Artifact tool execution timed out after ${options.timeoutMs} ms`)), options.timeoutMs);
    timer.unref();
    options.signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 1024 * 1024)) { stop(new Error('Artifact tool output exceeded its limit')); return; }
      chunks.push(chunk);
    });
    // CLI errors use the bounded JSON protocol. Never return raw launcher stderr to reviewers.
    child.stderr?.resume();
    child.stdin?.on('error', () => {});
    child.on('error', () => { if (failure) kill('SIGKILL'); finish(failure ?? new Error('The registered tool executable could not be started')); });
    child.on('close', code => {
      if (failure) kill('SIGKILL');
      finish(failure ?? (code === 0 ? undefined : new Error('The registered tool executable did not finish successfully')));
    });
    child.stdin?.end(options.input ?? '');
    if (options.signal.aborted) abort();
  });
}
