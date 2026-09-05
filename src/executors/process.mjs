import { spawn } from 'node:child_process';

/** Spawn directly, never through a shell. Cancel the complete child process group. */
export function runProcess(command, args, { cwd, env, input, signal, timeoutMs = 180_000, capture = true, maxOutputBytes = 128 * 1024, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Execution aborted')); return; }
    let child;
    try { child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', outputTruncated = false, failure, killTimer;
    const stop = reason => {
      if (failure) return;
      failure = new Error(reason);
      const kill = sig => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {}
      };
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const abort = () => stop('Execution aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(`Execution timed out after ${timeoutMs} ms`), timeoutMs);
    timer.unref();
    const collect = key => chunk => {
      if (!capture) return;
      const text = chunk.toString('utf8');
      const current = key === 'stdout' ? stdout : stderr;
      const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(current));
      if (Buffer.byteLength(text) > remaining) outputTruncated = true;
      const bounded = Buffer.from(text).subarray(0, remaining).toString('utf8');
      if (key === 'stdout') stdout += bounded; else stderr += bounded;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (exitCode, exitSignal) => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ exitCode, exitSignal, stdout, stderr, outputTruncated });
    });
    child.stdin.end(input ?? '');
  });
}
