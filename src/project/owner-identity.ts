import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactFamilyMembership, StaleStrategy } from '../definitions.js';
import { environmentOutputDirectory, runEnvironmentScript } from '../tools/environment.js';
import { scopedPath } from '../tools/paths.js';

/**
 * Identity scripts use the readiness executor; the snapshot caller owns the read-only workspace lease.
 * Stdin names the Artifact, so one shared family script can compute each instance's value.
 */
export async function ownerIdentity(root: string, owner: string, id: string, strategy: Extract<StaleStrategy, { kind: 'identity' }>, signal?: AbortSignal, family?: ArtifactFamilyMembership) {
  const label = `Identity script for Artifact ${id}`;
  const cwd = await scopedPath(root, owner);
  const entry = strategy.script.command === 'node' ? strategy.script.args[0] : strategy.script.command;
  const script = await scopedPath(cwd, entry);
  if (!(await lstat(script)).isFile()) throw new Error(`${label} requires a regular entry file.`);
  for (const input of strategy.inputs ?? []) { signal?.throwIfAborted(); await lstat(await scopedPath(cwd, input)); }
  // Temporary output is never state and is removed even on invalid output, timeout or cancellation.
  const base = await environmentOutputDirectory(root, tmpdir());
  const outputDir = await mkdtemp(join(base, 'ccdd-identity-'));
  const description = 'Identity validation failed.';
  let value = '', primary: { error: unknown } | undefined;
  try {
    const temporary = await environmentOutputDirectory(root, join(outputDir, '.tmp'));
    const node = strategy.script.command === 'node';
    const result = await runEnvironmentScript({
      command: node ? process.execPath : script,
      args: node ? [fileURLToPath(new URL('../tools/environment-host.js', import.meta.url)), root, script, ...strategy.script.args.slice(1)] : strategy.script.args,
      cwd, outputDir, tmpDir: temporary, signal, timeoutMs: strategy.timeoutMs, label, description,
      input: JSON.stringify({ version: 1, artifactId: id, ...(family ? { family: { name: family.name, material: family.material } } : {}) }),
    });
    signal?.throwIfAborted();
    if (!result.ok) throw new Error(result.message);
    // Do not trim: whitespace, extra lines, carriage returns and invalid bytes are authoring errors.
    value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
    if (value.length < 1 || value.length > 128 || /[^A-Za-z0-9._:-]/.test(value)) throw new Error(`${label} stdout must be one line of 1–128 characters from [A-Za-z0-9._:-], with only one optional trailing newline.`);
  } catch (error) { primary = { error }; }
  // A script can leave output that cannot be removed; fs error text would name local paths.
  const cleaned = await rm(outputDir, { recursive: true, force: true }).then(() => true, () => false);
  // Precedence: cancellation, then the script's own failure, then cleanup.
  signal?.throwIfAborted();
  if (primary) throw primary.error;
  if (!cleaned) throw new Error(`${label} failed: ${description}`);
  return { value };
}
