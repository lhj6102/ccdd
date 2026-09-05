import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
export type SpawnImplementation = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface ProcessResult { exitCode: number | null; exitSignal: NodeJS.Signals | null; stdout: string; stderr: string; outputTruncated: boolean }
export interface ProcessOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; timeoutMs?: number; capture?: boolean; maxOutputBytes?: number; onOutput?: (stream: 'stdout'|'stderr', bytes: Buffer) => void; spawnImpl?: SpawnImplementation }

/** Spawn directly, never through a shell. Cancel the complete child process group. */
export function runProcess(command: string, args: string[], { cwd, env, input, signal, timeoutMs = 180_000, capture = true, maxOutputBytes = 128 * 1024, onOutput, spawnImpl = spawn }: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Execution aborted')); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', outputTruncated = false;
    let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = new Error(reason);
      const kill = (sig: NodeJS.Signals) => {
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
    const collect = (key: 'stdout'|'stderr') => (chunk: Buffer) => {
      onOutput?.(key, chunk);
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
