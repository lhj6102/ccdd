#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGitHubClient, planRelease, publishRelease, readReleaseMetadata, validateAssets } from './release.mjs';
import { createNpmClient, publishNpmRelease } from './npm-release.mjs';
import { checkNpmEnvironment } from './check-npm.mjs';

const exec = promisify(execFile);
const commitPattern = /^[a-f0-9]{40}(?![\s\S])/;
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
const usage = 'npm run release -- --commit <40-character SHA> [--npm] [--dry-run] [--output-dir <empty directory outside the repo>]';

export function parseArguments(argv) {
  const options = { dryRun: false, help: false, npm: false }, seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    assert.ok(['--commit', '--dry-run', '--output-dir', '--help', '--npm'].includes(key) && !seen.has(key), `Unknown or repeated argument: ${key}`);
    seen.add(key);
    if (key === '--dry-run') options.dryRun = true;
    else if (key === '--npm') options.npm = true;
    else if (key === '--help') options.help = true;
    else {
      const value = argv[++index];
      assert.ok(value && !value.startsWith('--'), `${key} requires a value`);
      options[key === '--commit' ? 'commit' : 'outputDir'] = value;
    }
  }
  if (!options.help) assert.ok(typeof options.commit === 'string' && commitPattern.test(options.commit), '--commit requires an exact 40-character commit SHA');
  return options;
}

export function repositoryFromRemote(remote) {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?![\s\S])/.exec(remote);
  assert.ok(match && [match[1], match[2]].every(part => part !== '.' && part !== '..'), 'origin must be an SSH or HTTPS github.com owner/repository URL');
  return `${match[1]}/${match[2]}`;
}

// Build and test children get an isolated home and public npm configuration.
// GitHub credentials are read only by the publisher, never inherited by these children.
export function buildEnvironment(scratch, inherited = process.env) {
  const environment = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'LANG', 'LC_ALL'].filter(key => inherited[key] !== undefined).map(key => [key, inherited[key]]));
  return { ...environment, HOME: join(scratch, 'home'), CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'empty-gitconfig'),
    npm_config_userconfig: join(scratch, 'user.npmrc'), npm_config_globalconfig: join(scratch, 'global.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/', npm_config_cache: inherited.npm_config_cache || inherited.NPM_CONFIG_CACHE || join(scratch, 'npm-cache'),
  };
}

export async function createSnapshot({ sourceRoot, commit, scratch, environment, signal }) {
  assert.ok(commitPattern.test(commit), 'Use an exact commit SHA');
  const options = { cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, signal };
  const actual = (await exec('git', ['rev-parse', '--verify', `${commit}^{commit}`], options)).stdout.trim();
  assert.equal(actual, commit, 'Requested object must be a commit, not a tag');
  const checkout = join(scratch, 'checkout');
  // The Git transport copies committed objects without sharing the caller's index,
  // worktree, hooks, untracked files, local config or dirty file contents.
  await exec('git', ['clone', '--no-local', '--no-checkout', '--', sourceRoot, checkout], options);
  await exec('git', ['checkout', '--detach', commit], { ...options, cwd: checkout });
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { ...options, cwd: checkout })).stdout.trim(), commit);
  assert.equal((await exec('git', ['status', '--porcelain', '--untracked-files=all'], { ...options, cwd: checkout })).stdout, '');
  return realpath(checkout);
}

export async function resolveOutputDirectory(path, excludedRoots) {
  let ancestor = resolve(path);
  const suffix = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const canonical = join(ancestor, ...suffix);
  assert.ok(excludedRoots.every(root => !within(root, canonical)), 'Release output must be outside the source repository and temporary checkout');
  return canonical;
}

async function runStep(program, args, { cwd, env, logFile, timeout = 600_000, signal }) {
  const log = await open(logFile, 'w'), errors = await open(`${logFile}.stderr`, 'w');
  try {
    await new Promise((resolveStep, reject) => {
      const child = spawn(program, args, { cwd, env, stdio: ['ignore', log.fd, errors.fd], detached: process.platform !== 'win32' });
      let stopped;
      const stopGroup = () => {
        if (!child.pid) return;
        try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      };
      const terminate = reason => {
        if (stopped) return;
        stopped = reason;
        stopGroup();
      };
      const abort = () => terminate('cancelled');
      const timer = setTimeout(() => terminate('timed out'), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); stopGroup(); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => { cleanup(); code === 0 && !stopped ? resolveStep() : reject(new Error(`${program} ${args[0]} ${stopped ?? `failed (exit ${code})`}. See ${logFile} and ${logFile}.stderr`)); });
    });
  } finally { await log.close(); await errors.close(); }
}

export async function releaseLocally(options, { cwd = process.cwd(), environment = process.env, progress = console.log } = {}) {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Local releases require Node.js 24 or later');
  const sourceRoot = await realpath((await exec('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })).stdout.trim());
  const scratch = await mkdtemp(join(tmpdir(), 'ccdd-release-checkout-'));
  const buildEnv = buildEnvironment(scratch, environment), controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let reportDirectory;
  try {
    await mkdir(buildEnv.HOME);
    await Promise.all(['empty-gitconfig', 'user.npmrc', 'global.npmrc'].map(file => writeFile(join(scratch, file), '')));
    progress(`Preparing isolated commit ${options.commit}`);
    const root = await createSnapshot({ sourceRoot, commit: options.commit, scratch, environment: buildEnv, signal: controller.signal });
    const metadata = await readReleaseMetadata(root);
    let api, repository;
    if (options.npm && !options.dryRun) {
      const preflight = await checkNpmEnvironment({ environment });
      assert.equal(preflight.status, 'READY', `npm environment is not ready: ${preflight.checks.filter(check => !check.ok).map(check => `${check.id}: ${check.detail}`).join('; ')}. Run npm run release:npm:check.`);
    }
    if (!options.dryRun && !options.npm) {
      const remote = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: sourceRoot, encoding: 'utf8', signal: controller.signal })).stdout.trim();
      repository = repositoryFromRemote(remote);
      let token;
      try { token = (await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 30_000, signal: controller.signal })).stdout.trim(); }
      catch { throw new Error('GitHub authentication is required. Run gh auth login, or use --dry-run.'); }
      api = createGitHubClient({ repository, token, signal: controller.signal });
      const remoteCommit = await api.request('GET', `commits/${options.commit}`);
      assert.equal(remoteCommit.sha, options.commit, 'Push the requested commit to origin before publishing');
      const plan = await planRelease({ root, repository, sourceCommit: options.commit, api });
      if (plan.already_published) return { status: 'ALREADY_PUBLISHED', version: metadata.version, sourceCommit: options.commit, url: plan.url };
    }
    reportDirectory = await mkdtemp(join(tmpdir(), `ccdd-release-${metadata.version}-`));
    const outputPath = await resolveOutputDirectory(options.outputDir ?? join(reportDirectory, 'assets'), [sourceRoot, await realpath(scratch)]);
    await mkdir(outputPath, { recursive: true });
    const assetsDir = await realpath(outputPath);
    assert.ok(!within(sourceRoot, assetsDir) && !within(scratch, assetsDir), 'Release output must be outside the source repository and temporary checkout');
    assert.equal((await readdir(assetsDir)).length, 0, 'Release output directory must be empty');
    const step = async (label, program, args, file) => {
      controller.signal.throwIfAborted();
      progress(`${label} (log: ${join(reportDirectory, file)})`);
      await runStep(program, args, { cwd: root, env: buildEnv, logFile: join(reportDirectory, file), signal: controller.signal });
    };
    await step('Installing locked build dependencies', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'install.log');
    await step('Building core, default tools and monitor', 'npm', ['run', 'build'], 'build.log');
    const tests = (await readdir(join(root, 'dist/test'))).filter(file => file.endsWith('.test.js')).sort().map(file => join(root, 'dist/test', file));
    assert.ok(tests.length, 'No compiled tests found');
    await step('Running the complete test suite', process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...tests], 'tests.tap');
    await step('Verifying packed production installs and actual tool/runtime execution', process.execPath, [join(root, 'scripts/verify-release.mjs'), '--version', metadata.version, '--tag', metadata.tag, '--source-commit', options.commit, '--output-dir', assetsDir, '--test-report', join(reportDirectory, 'tests.tap')], 'verification.log');
    await validateAssets(assetsDir, metadata, options.commit);
    controller.signal.throwIfAborted();
    if (options.npm) {
      progress(`${options.dryRun ? 'Checking' : 'Publishing'} npm packages from verified commit ${options.commit}`);
      const client = createNpmClient({ environment: options.dryRun ? buildEnv : environment, signal: controller.signal });
      const result = await publishNpmRelease({ assetsDir, metadata, sourceCommit: options.commit, client, dryRun: options.dryRun });
      return { ...result, version: metadata.version, sourceCommit: options.commit, assetsDir, logs: reportDirectory };
    }
    if (options.dryRun) return { status: 'VERIFIED', version: metadata.version, sourceCommit: options.commit, assetsDir, logs: reportDirectory, published: false };
    progress(`Publishing ${repository} ${metadata.tag} from verified commit ${options.commit}`);
    const published = await publishRelease({ root, repository, sourceCommit: options.commit, assetsDir, api });
    return { status: published.published ? 'PUBLISHED' : 'ALREADY_PUBLISHED', version: metadata.version, sourceCommit: options.commit, assetsDir, logs: reportDirectory, ...published };
  } catch (error) {
    if (reportDirectory) progress(`Release stopped. Local logs: ${reportDirectory}`);
    throw error;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage);
    else console.log(JSON.stringify(await releaseLocally(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
