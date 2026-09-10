import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packedManifest, validateAssets } from './release.mjs';

const registry = 'https://registry.npmjs.org/';
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function createNpmClient({ environment = process.env, signal } = {}, fetchImpl = fetch) {
  return {
    async version(name, version) {
      signal?.throwIfAborted();
      // Public package metadata requires no credentials. Never forward npm auth to fetch.
      const response = await fetchImpl(`${registry}${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      });
      if (response.status === 404) return null;
      assert.ok(response.ok, `npm metadata lookup failed for ${name}: HTTP ${response.status}`);
      return response.json();
    },
    async publish(file, bytes, { dryRun }) {
      signal?.throwIfAborted();
      const staging = await mkdtemp(join(tmpdir(), 'ccdd-npm-publish-'));
      try {
        // Publish the already verified bytes, even if the caller's assets later change.
        const tarball = join(staging, file);
        await writeFile(tarball, bytes, { mode: 0o400 });
        const args = ['publish', tarball, '--ignore-scripts', '--workspaces=false', '--access=public', '--tag=latest',
          `--registry=${registry}`, `--@ccdd:registry=${registry}`, '--provenance=false', ...(dryRun ? ['--dry-run'] : [])];
        await new Promise((resolve, reject) => {
          // Inherit the terminal so npm can handle interactive authentication/2FA.
          const child = spawn('npm', args, { cwd: staging, env: environment, stdio: 'inherit', signal });
          child.once('error', reject);
          child.once('close', code => code === 0 ? resolve() : reject(new Error(`npm publish failed for ${file} (exit ${code}). Rerun the same commit to resume.`)));
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
  };
}

function matchesPublished(published, name, version, bytes) {
  assert.ok(published, `npm has not confirmed ${name}@${version} yet. Rerun the same commit to check and resume publication.`);
  assert.ok(published.name === name && published.version === version && published.dist?.integrity === integrity(bytes),
    `npm already contains different bytes for ${name}@${version}. Choose a new version for all three packages; published versions cannot be replaced.`);
}

export async function planNpmRelease({ files, metadata, client }) {
  assert.ok(metadata.projectFile, 'npm publication requires core, Project and default-tools packages');
  // Core must be available before packages that declare it as a peer dependency.
  const packages = [['@ccdd/core', metadata.coreFile], ['@ccdd/project', metadata.projectFile], ['@ccdd/default-tools', metadata.toolsFile]];
  const plan = [];
  for (const [name, file] of packages) {
    const bytes = files.get(file), manifest = packedManifest(bytes);
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, metadata.version);
    assert.notEqual(manifest.private, true, `${name} has private: true; select a commit with npm publication enabled`);
    assert.deepEqual(manifest.publishConfig, { access: 'public', registry }, `${name} must explicitly publish to the public npm registry`);
    const published = await client.version(name, metadata.version);
    if (published) matchesPublished(published, name, metadata.version, bytes);
    plan.push({ name, file, bytes, alreadyPublished: published !== null });
  }
  return plan;
}

export async function publishNpmRelease({ assetsDir, metadata, sourceCommit, client, dryRun = false }) {
  const files = await validateAssets(assetsDir, metadata, sourceCommit);
  // Check every package before making any registry writes, including on retries.
  const plan = await planNpmRelease({ files, metadata, client });
  const packages = [];
  for (const pkg of plan) {
    if (!pkg.alreadyPublished) {
      await client.publish(pkg.file, pkg.bytes, { dryRun });
      if (!dryRun) matchesPublished(await client.version(pkg.name, metadata.version), pkg.name, metadata.version, pkg.bytes);
    }
    packages.push({ name: pkg.name, status: pkg.alreadyPublished ? 'ALREADY_PUBLISHED' : dryRun ? 'VERIFIED' : 'PUBLISHED' });
  }
  return { status: dryRun ? 'VERIFIED' : packages.every(pkg => pkg.status === 'ALREADY_PUBLISHED') ? 'ALREADY_PUBLISHED' : 'PUBLISHED',
    registry, published: packages.some(pkg => pkg.status === 'PUBLISHED'), packages };
}
