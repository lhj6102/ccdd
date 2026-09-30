import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResultCheck, ReviewToolCall } from '../contracts.js';
import { environmentOutputDirectory, runEnvironmentScript } from '../tools/environment.js';
import { scopedPath } from '../tools/paths.js';
import { object } from '../tools/schema.js';
import { diagnosticError } from './errors.js';

const MAX_ERRORS = 8, MAX_ERROR_BYTES = 4096;
const failed = () => diagnosticError('RESULT_CHECK_FAILED', 'The Critic result check did not complete with a valid report.',
  'Run the check script with a recorded result and tool calls on stdin; it must exit 0 and print {"errors":[...]}.');

/**
 * Run an Agent Critic's result check on a schema-valid final result. The script reads
 * {version, result, toolCalls} on stdin and prints {"errors": [...]}; an empty list accepts.
 * Error text is author-controlled and only reaches the repair prompt, never stored state.
 */
export async function runResultCheck({ worktreePath, ownerPath, check, result, toolCalls, runDir, signal }: {
  worktreePath: string; ownerPath: string; check: ResultCheck; result: unknown; toolCalls: readonly ReviewToolCall[]; runDir: string; signal?: AbortSignal;
}): Promise<string[]> {
  // Missing scripts and output setup failures report the same fixed error, never a local path.
  const prepared = await (async () => {
    const root = await realpath(worktreePath), cwd = await scopedPath(root, ownerPath), script = await scopedPath(cwd, check.script);
    return { root, cwd, script, outputDir: await mkdtemp(join(await environmentOutputDirectory(root, join(runDir, 'result-check')), 'check-')) };
  })().catch(() => { signal?.throwIfAborted(); throw failed(); });
  const { root, cwd, script, outputDir } = prepared;
  try {
    const input = JSON.stringify({ version: 1, result, toolCalls: toolCalls.map(call => ({
      artifactId: call.observation?.artifactId, operation: call.observation?.operation, arguments: call.arguments ?? {}, ...(call.isError ? { isError: true } : {}),
    })) });
    const run = await runEnvironmentScript({ command: process.execPath, args: [fileURLToPath(new URL('../tools/environment-host.js', import.meta.url)), root, script],
      cwd, outputDir, tmpDir: await environmentOutputDirectory(root, join(outputDir, '.tmp')), signal, timeoutMs: check.timeoutMs,
      label: 'Result check', description: 'Result check completed.', input });
    signal?.throwIfAborted();
    if (!run.ok) throw failed();
    let report: unknown;
    try { report = JSON.parse(run.stdout); } catch { throw failed(); }
    if (!object(report) || Object.keys(report).some(key => key !== 'errors') || !Array.isArray(report.errors) || report.errors.length > MAX_ERRORS
      || report.errors.some((error: unknown) => typeof error !== 'string' || !error.trim()) || Buffer.byteLength(report.errors.join('\n')) > MAX_ERROR_BYTES) throw failed();
    return report.errors as string[];
  } finally { await rm(outputDir, { recursive: true, force: true }); }
}
