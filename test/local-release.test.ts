import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const driverUrl = new URL('../../scripts/local-release.mjs', import.meta.url);
const { buildEnvironment, createSnapshot, resolveOutputDirectory, releaseLocally } = await import(driverUrl.href);
const exec = promisify(execFile), commit = 'a'.repeat(40);

test('release CLI entrypoints still execute when invoked through symlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ccdd-release-entrypoint-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = join(directory, 'local.mjs'), verify = join(directory, 'verify.mjs');
  await symlink(fileURLToPath(driverUrl), local);
  await symlink(fileURLToPath(new URL('../../scripts/verify-release.mjs', import.meta.url)), verify);
  const help = await exec(process.execPath, [local, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /npm run release -- --commit/);
  await assert.rejects(exec(process.execPath, [verify], { encoding: 'utf8' }), (error: unknown) => {
    const result = error as { code: number; stderr: string };
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing --version/);
    return true;
  });
});

test('legacy GitHub tarball publication stops before reading credentials or building', async () => {
  await assert.rejects(releaseLocally({ commit, npm: false, dryRun: false }, { cwd: '/nonexistent', environment: {} }), /downloads have moved to npm/);
});

test('build children receive isolated public npm and Git settings without Provider or publisher credentials', () => {
  const scratch = '/tmp/ccdd-local-release-test';
  const inherited = {
    PATH: '/usr/bin:/bin', TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp', SYSTEMROOT: 'C:\\Windows',
    LANG: 'en_US.UTF-8', LC_ALL: 'C', HOME: '/private-user-home',
    GH_TOKEN: 'private-sentinel-gh', GITHUB_TOKEN: 'private-sentinel-github',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://private-sentinel-oidc.example/',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-sentinel-oidc-token',
    OPENAI_API_KEY: 'private-sentinel-openai', ANTHROPIC_API_KEY: 'private-sentinel-anthropic',
    CCDD_PI_AUTH_FILE: '/private-sentinel-pi-auth', CCDD_CODEX_AUTH_FILE: '/private-sentinel-codex-auth',
    NODE_AUTH_TOKEN: 'private-sentinel-npm', AWS_SECRET_ACCESS_KEY: 'private-sentinel-aws',
    npm_config_registry: 'https://private-sentinel-registry.example/',
    npm_config_userconfig: '/private-sentinel-user.npmrc', NPM_CONFIG_GLOBALCONFIG: '/private-sentinel-global.npmrc',
    NODE_OPTIONS: '--import=/private-sentinel-hook.mjs', NODE_PATH: '/private-sentinel-modules',
    GIT_SSH_COMMAND: 'private-sentinel-ssh', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/private-sentinel-hooks', GIT_DIR: '/private-sentinel-git',
  };
  const before = structuredClone(inherited), environment = buildEnvironment(scratch, inherited);
  assert.deepEqual(inherited, before, 'Constructing a build environment does not edit the publisher environment.');
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'LANG', 'LC_ALL']) assert.equal(environment[key], inherited[key as keyof typeof inherited]);
  assert.equal(environment.HOME, join(scratch, 'home'));
  assert.equal(environment.npm_config_registry, 'https://registry.npmjs.org/');
  assert.equal(environment.npm_config_userconfig, join(scratch, 'user.npmrc'));
  assert.equal(environment.npm_config_globalconfig, join(scratch, 'global.npmrc'));
  assert.equal(environment.npm_config_cache, join(scratch, 'npm-cache'));
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(environment.GIT_CONFIG_GLOBAL, join(scratch, 'empty-gitconfig'));
  assert.equal(JSON.stringify(environment).includes('private-sentinel'), false);
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CCDD_PI_AUTH_FILE', 'CCDD_CODEX_AUTH_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_DIR', 'NODE_AUTH_TOKEN']) assert.equal(Object.hasOwn(environment, key), false, key);
});

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-local-release-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'source repository'), scratch = join(directory, 'scratch');
  await mkdir(sourceRoot); await mkdir(scratch);
  const environment = buildEnvironment(scratch, { PATH: process.env.PATH, TMPDIR: tmpdir() });
  await mkdir(environment.HOME);
  await Promise.all(['empty-gitconfig', 'user.npmrc', 'global.npmrc'].map(file => writeFile(join(scratch, file), '')));
  const git = async (args: string[]) => (await exec('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 20_000 })).stdout.trim();
  await git(['init', '--initial-branch=main']);
  await writeFile(join(sourceRoot, 'document.md'), 'Original committed Artifact.\n');
  await git(['add', 'document.md']); await git(['commit', '-m', 'Original snapshot']);
  const first = await git(['rev-parse', 'HEAD']);
  await writeFile(join(sourceRoot, 'document.md'), 'Newer committed Artifact.\n');
  await writeFile(join(sourceRoot, 'newer-only.md'), 'Not present in the requested snapshot.\n');
  await git(['add', '.']); await git(['commit', '-m', 'Newer snapshot']);
  const second = await git(['rev-parse', 'HEAD']);
  await git(['remote', 'add', 'origin', join(directory, 'nonexistent-original-remote.git')]);
  await writeFile(join(sourceRoot, 'document.md'), 'Dirty Artifact; never include in release.\n');
  await writeFile(join(sourceRoot, 'private-untracked.txt'), 'Untracked workspace content.\n');
  return { directory, sourceRoot, scratch, environment, git, first, second };
}

test('local release checks out the selected earlier commit independently and preserves the caller workspace', async t => {
  const data = await fixture(t);
  const status = await data.git(['status', '--porcelain', '--untracked-files=all']);
  const originalRemote = await data.git(['remote', 'get-url', 'origin']);
  const checkout = await createSnapshot({ sourceRoot: data.sourceRoot, commit: data.first, scratch: data.scratch, environment: data.environment });
  assert.notEqual(checkout, data.sourceRoot);
  assert.equal(await readFile(join(checkout, 'document.md'), 'utf8'), 'Original committed Artifact.\n');
  await assert.rejects(readFile(join(checkout, 'newer-only.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(checkout, 'private-untracked.txt')), { code: 'ENOENT' });
  const checkedGit = async (args: string[]) => (await exec('git', args, { cwd: checkout, env: data.environment, encoding: 'utf8', timeout: 20_000 })).stdout.trim();
  assert.equal(await checkedGit(['rev-parse', 'HEAD']), data.first);
  assert.equal(await checkedGit(['status', '--porcelain', '--untracked-files=all']), '');
  await assert.rejects(checkedGit(['symbolic-ref', '--quiet', 'HEAD']), 'The release checkout must use detached HEAD.');
  await writeFile(join(checkout, 'document.md'), 'Release-checkout-only modification.\n');
  assert.equal(await data.git(['rev-parse', 'HEAD']), data.second);
  assert.equal(await data.git(['status', '--porcelain', '--untracked-files=all']), status);
  assert.equal(await data.git(['remote', 'get-url', 'origin']), originalRemote);
  assert.equal(await readFile(join(data.sourceRoot, 'document.md'), 'utf8'), 'Dirty Artifact; never include in release.\n');
  assert.equal(await readFile(join(data.sourceRoot, 'private-untracked.txt'), 'utf8'), 'Untracked workspace content.\n');
});

test('local release does not accept a tag object, blob, missing object or branch in place of the exact commit', async t => {
  const data = await fixture(t);
  await data.git(['tag', '--annotate', 'annotated-release', '--message', 'A tag object is not a commit', data.first]);
  const annotated = await data.git(['rev-parse', 'refs/tags/annotated-release']);
  const blob = await data.git(['rev-parse', `${data.first}:document.md`]);
  for (const requested of [annotated, blob, '0'.repeat(40), 'main', `${data.first}\n`]) {
    await assert.rejects(createSnapshot({ sourceRoot: data.sourceRoot, commit: requested, scratch: data.scratch, environment: data.environment }));
  }
  assert.equal(await data.git(['rev-parse', 'HEAD']), data.second);
  await assert.rejects(readFile(join(data.scratch, 'checkout/document.md')), { code: 'ENOENT' });
});

test('release output validation rejects source and symlink destinations before creating any directories', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-release-output-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, 'source'), scratch = join(directory, 'temporary-checkout');
  await mkdir(sourceRoot); await mkdir(scratch);
  await writeFile(join(sourceRoot, 'preserve.md'), 'Caller-owned content.\n');
  const alias = join(directory, 'source-alias');
  await symlink(sourceRoot, alias, 'dir');
  const excluded = [sourceRoot, scratch];
  for (const output of [sourceRoot, join(sourceRoot, 'new-output/nested'), alias, join(alias, 'new-output/nested'), join(scratch, 'new-output/nested')]) {
    await assert.rejects(resolveOutputDirectory(output, excluded), /outside the source repository/);
  }
  assert.deepEqual(await readdir(sourceRoot), ['preserve.md']);
  assert.equal(await readFile(join(sourceRoot, 'preserve.md'), 'utf8'), 'Caller-owned content.\n');
  assert.deepEqual(await readdir(scratch), []);
  await assert.rejects(lstat(join(sourceRoot, 'new-output')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(scratch, 'new-output')), { code: 'ENOENT' });

  const outside = join(directory, 'outside/nested/assets');
  assert.equal(await resolveOutputDirectory(outside, excluded), outside);
  await assert.rejects(lstat(join(directory, 'outside')), { code: 'ENOENT' });
  const similarPrefix = join(directory, 'source-backup/assets');
  assert.equal(await resolveOutputDirectory(similarPrefix, excluded), similarPrefix);
  await assert.rejects(lstat(join(directory, 'source-backup')), { code: 'ENOENT' });
});
