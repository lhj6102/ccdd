#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGitHubClient, readReleaseMetadata } from './release.mjs';
import { createNpmClient } from './npm-release.mjs';
import { publishNpmAndAnnounce } from './npm-announcement.mjs';

const exec = promisify(execFile);

// CI owns building and verification. This entrypoint only retrieves its packages
// and publishes them; the existing publisher checks their identity and integrity.
export async function publishFromCi({ root, repository, sourceCommit, ref, assetsDir, api, client, download }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const metadata = await readReleaseMetadata(root);
  assert.equal(ref, `refs/tags/${metadata.tag}`, 'The release tag must match the package version');
  const query = new URLSearchParams({ head_sha: sourceCommit, branch: 'main', event: 'push', status: 'success', per_page: '1' });
  const { workflow_runs: runs } = await api.request('GET', `actions/workflows/ci.yml/runs?${query}`);
  const run = runs[0];
  assert.ok(run && run.head_sha === sourceCommit && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success',
    'No successful main CI for this commit. Wait for CI, then rerun Release.');
  await download(run.id, `release-${sourceCommit}`, assetsDir);
  return publishNpmAndAnnounce({ assetsDir, metadata, sourceCommit, repository, api, client });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/publish-ci.mjs <download-directory>');
    const root = process.cwd(), environment = process.env;
    assert.equal(environment.GITHUB_ACTIONS, 'true', 'Use the Release workflow to publish CI packages');
    const repository = environment.GITHUB_REPOSITORY;
    const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const api = createGitHubClient({ repository, token: environment.GH_TOKEN });
    const result = await publishFromCi({ root, repository, sourceCommit, ref: environment.GITHUB_REF,
      assetsDir: resolve(process.argv[2]), api, client: createNpmClient(),
      download: (runId, name, directory) => exec('gh', ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', directory]),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
