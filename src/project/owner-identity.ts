import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StaleStrategy } from '../definitions.js';
import { environmentOutputDirectory, runEnvironmentScript } from '../tools/environment.js';
import { scopedPath } from '../tools/paths.js';

/** Identity scripts use the readiness executor; the snapshot caller owns the read-only workspace lease. */
export async function ownerIdentity(root: string, owner: string, id: string, strategy: Extract<StaleStrategy, { kind: 'identity' }>, signal?: AbortSignal) {
  const label = `Identity script for Artifact ${id}`;
  const cwd = await scopedPath(root, owner);
  const entry = strategy.script.command === 'node' ? strategy.script.args[0] : strategy.script.command;
  const script = await scopedPath(cwd, entry);
  if (!(await lstat(script)).isFile()) throw new Error(`${label} requires a regular entry file.`);
  for (const input of strategy.inputs ?? []) { signal?.throwIfAborted(); await lstat(await scopedPath(cwd, input)); }
  // Temporary output is never state and is removed even on invalid output, timeout or cancellation.
  const base = await environmentOutputDirectory(root, tmpdir());
  const outputDir = await mkdtemp(join(base, 'ccdd-identity-'));
  try {
    const temporary = await environmentOutputDirectory(root, join(outputDir, '.tmp'));
    const node = strategy.script.command === 'node';
    const result = await runEnvironmentScript({
      command: node ? process.execPath : script,
      args: node ? [fileURLToPath(new URL('../tools/environment-host.js', import.meta.url)), root, script, ...strategy.script.args.slice(1)] : strategy.script.args,
      cwd, outputDir, tmpDir: temporary, signal, timeoutMs: strategy.timeoutMs, label, description: 'Identity validation failed.',
    });
    signal?.throwIfAborted();
    if (!result.ok) throw new Error(result.message);
    // Do not trim: whitespace, extra lines, carriage returns and invalid bytes are authoring errors.
    const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
    if (value.length < 1 || value.length > 128 || /[^A-Za-z0-9._:-]/.test(value)) throw new Error(`${label} stdout must be one line of 1–128 characters from [A-Za-z0-9._:-], with only one optional trailing newline.`);
    return { value };
  } finally { await rm(outputDir, { recursive: true, force: true }); }
}
