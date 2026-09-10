#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nodeRequirement, supportedNodeRange, supportsNodeVersion } from '../src/node-version.ts';

const exec = promisify(execFile);
const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreName = '@ccdd/core';
const toolsName = '@ccdd/default-tools';
const projectName = '@ccdd/project';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };

export function parseArguments(argv) {
  const allowed = new Set(['--version', '--tag', '--source-commit', '--output-dir', '--test-report']);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    assert.ok(allowed.has(key) && !Object.hasOwn(options, key), `Unknown or repeated argument: ${key}`);
    assert.ok(value && !value.startsWith('--'), `${key} requires a value`);
    options[key] = value;
  }
  for (const key of allowed) assert.ok(options[key], `Missing ${key}`);
  assert.match(options['--version'], /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a stable semantic version');
  assert.equal(options['--tag'], `v${options['--version']}`, 'The tag must match the package version');
  assert.match(options['--source-commit'], /^[a-f0-9]{40}$/, 'Use the full Git source commit');
  return options;
}

export function readTestSummary(tap) {
  assert.match(tap, /^TAP version 13\r?$/m, 'Expected a Node TAP test report');
  assert.doesNotMatch(tap, /^Bail out!/m, 'The test runner bailed out');
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `Expected one final TAP ${key} total`);
    summary[key] = Number(matches[0][1]);
    assert.ok(Number.isSafeInteger(summary[key]), `Invalid TAP ${key} total`);
  }
  assert.ok(summary.tests > 0 && summary.pass > 0, 'The test suite must run and pass tests');
  assert.equal(summary.fail, 0, 'The test suite contains failures');
  assert.equal(summary.cancelled, 0, 'The test suite contains cancelled tests');
  assert.equal(summary.skipped, 0, 'Release verification does not accept skipped tests');
  assert.equal(summary.todo, 0, 'Release verification does not accept unfinished tests');
  assert.equal(summary.tests, summary.pass + summary.skipped, 'Inconsistent TAP totals');
  assert.doesNotMatch(tap, /^not ok \d+/m, 'The test report contains a failed top-level test');
  return summary;
}

/** Only distributable code and documentation may enter release packages. */
export function packageFileAllowed(packageName, path) {
  if (![coreName, toolsName, projectName].includes(packageName)) return false;
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) return false;
  if (path.split('/').some(part => /^(?:node_modules|output|worktrees?|snapshots?|state|sources|\.git|\.ccdd|\.codex|\.ssh|\.aws|\.npmrc)$/i.test(part))) return false;
  if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\.[^/]*)?)$/i.test(path) || /\.(?:db|sqlite(?:3)?|pem|key|tgz|zip)$/i.test(path)) return false;
  if (/^(?:package\.json|README\.md|LICENSE(?:\.[A-Za-z]+)?)$/.test(path)) return true;
  if (packageName === toolsName) return /^dist\/.+\.(?:js|js\.map|d\.ts)$/.test(path);
  if (packageName === coreName) return /^dist\/src\/(?:sdk|definitions|tools\/contracts)\.(?:js|js\.map|d\.ts)$/.test(path) || /^examples\/.+\.(?:md|ts|mjs|json|png|jpg|jpeg|webp)$/.test(path);
  return /^dist\/(?:src|scripts)\/.+\.(?:js|js\.map|d\.ts)$/.test(path)
    || /^dist\/monitor-ui\/.+\.(?:html|js|css|svg|png|woff2?)$/.test(path)
    || /^docs\/.+\.md$/.test(path)
    || /^examples\/.+\.(?:md|ts|mjs|json|png|jpg|jpeg|webp)$/.test(path)
    || path === 'CONTEXT-MAP.md' || /^src\/.+\/CONTEXT\.md$/.test(path);
}

async function command(program, args, options = {}) {
  try {
    const windowsNpm = program === 'npm' && process.platform === 'win32';
    const target = windowsNpm || program.endsWith('.js') ? process.execPath : program;
    const argv = windowsNpm ? [process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args] : program.endsWith('.js') ? [program, ...args] : args;
    return await exec(target, argv, { cwd: sourceDirectory, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options });
  } catch (error) {
    // Commands only handle synthetic files and public packages. Keep raw command output out of the published report.
    const stderr = typeof error.stderr === 'string' ? error.stderr.slice(-6000) : '';
    const stdout = typeof error.stdout === 'string' ? error.stdout.slice(-6000) : '';
    throw new Error(`${program} ${args[0] ?? ''} failed (${error.code ?? 'unknown'}).\n${stderr || stdout}`, { cause: error });
  }
}

async function jsonCommand(program, args, options) {
  return JSON.parse((await command(program, args, options)).stdout);
}

export async function packPackage(cwd, expectedName, version, outputDirectory, environment) {
  const packed = await jsonCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDirectory], { cwd, env: environment });
  assert.equal(packed.length, 1, 'Each pack command must produce one package');
  const [metadata] = packed;
  assert.equal(metadata.name, expectedName);
  assert.equal(metadata.version, version);
  const expectedFile = `${expectedName.slice(1).replace('/', '-')}-${version}.tgz`;
  assert.equal(metadata.filename, expectedFile, 'Unexpected tarball filename');
  assert.ok(metadata.files.length > 0 && metadata.bundled.length === 0, 'Package must have files and no bundled dependencies');
  const paths = metadata.files.map(file => file.path).sort();
  for (const path of paths) assert.ok(packageFileAllowed(expectedName, path), `Unexpected release package file: ${expectedName}/${path}`);
  const tarball = join(outputDirectory, metadata.filename);
  // Validate the actual archive as well as npm's reported file list.
  const entries = (await command('tar', ['-tzf', tarball], { env: environment })).stdout.trim().split(/\r?\n/);
  assert.ok(entries.every(path => path.startsWith('package/') && !path.endsWith('/')), 'Unexpected archive root or directory entry');
  assert.deepEqual(entries.map(path => path.slice('package/'.length)).sort(), paths, 'Tar contents differ from the npm manifest');
  const manifest = JSON.parse((await command('tar', ['-xOf', tarball, 'package/package.json'], { env: environment })).stdout);
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.version, version);
  assert.equal(manifest.engines?.node, supportedNodeRange, 'Every package must declare the verified Node support range');
  assert.equal(manifest.license, 'MIT', 'Every package must declare the MIT license');
  const license = await readFile(join(sourceDirectory, 'LICENSE'), 'utf8');
  assert.equal((await command('tar', ['-xOf', tarball, 'package/LICENSE'], { env: environment })).stdout, license, 'Every package must include the complete repository license');
  const sourceManifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  assert.equal(manifest.private, sourceManifest.private, 'Packing must preserve npm publication policy');
  assert.deepEqual(manifest.publishConfig, sourceManifest.publishConfig, 'Packing must preserve npm registry and access settings');
  const required = expectedName === coreName
    ? ['dist/src/sdk.js', 'dist/src/sdk.d.ts', 'dist/src/definitions.d.ts', 'dist/src/tools/contracts.d.ts', 'examples/custom-text-reader/ccdd.config.ts']
    : expectedName === projectName ? ['dist/src/cli.js', 'dist/src/project/cli.js', 'dist/src/project/index.js', 'dist/src/worker.js', 'dist/scripts/prepare-demo.js', 'dist/monitor-ui/index.html']
    : ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/reader.js', 'dist/process.js'];
  if (expectedName === coreName) { assert.equal(manifest.bin, undefined); assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0); }
  for (const path of required) assert.ok(paths.includes(path), `Missing packaged runtime file: ${path}`);
  const bytes = await readFile(tarball);
  return { name: expectedName, version, file: metadata.filename, bytes: bytes.length, sha256: sha256(bytes), fileCount: paths.length };
}

function fixtureConfig(withDefaults) {
  const imports = withDefaults
    ? "import { defineConfig } from '@ccdd/core';\nimport { agent } from '@ccdd/default-tools';"
    : "import { defineConfig, defineTool } from '@ccdd/core';\nimport { readFile } from 'node:fs/promises';";
  const reader = withDefaults ? 'agent.text.read()' : `defineTool({
    metadata: { description: 'Read {artifactName} with a custom tool.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      resultKinds: ['text'], observation: 'content', artifactKind: 'file' },
    async execute(context) {
      const text = await readFile(await context.resolvePath(), { encoding: 'utf8', signal: context.signal });
      return { content: [{ type: 'text', text }], observation: { kind: 'content' } };
    },
  })`;
  return `${imports}
export default defineConfig(() => ({
  artifactTypes: { document: { agentTools: { ${withDefaults ? 'read' : 'inspect'}: ${reader} } } },
  artifacts: { spec: { type: 'document', path: 'spec.md', stale: { kind: 'file-hash', paths: ['spec.md', 'checks'] } } },
  critics: [{ id: 'package-runtime', title: 'Packaged runtime verification', target: 'spec', deps: [],
    profile: { kind: 'runtime', command: 'node', args: ['--test', 'checks/release.test.mjs'] },
    payload: { instruction: 'Run the synthetic package test for {spec}.' } }],
}));
`;
}

export async function verifyInstallation({ scratch, outputDirectory, packages, version, withDefaults, environment }) {
  const name = withDefaults ? 'core-and-default-tools' : 'core-only-custom-tool';
  const project = join(scratch, name);
  const input = join(project, 'review-input');
  const state = join(scratch, `${name}-state`);
  await mkdir(join(input, 'checks'), { recursive: true });
  const dependencies = Object.fromEntries(packages.filter(pkg => withDefaults || pkg.name !== toolsName).map(pkg => [pkg.name, `file:${join(outputDirectory, pkg.file)}`]));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: `ccdd-release-${name}`, private: true, type: 'module', dependencies }, null, 2));
  const sample = `CCDD ${version} package verification.\nSecond line.\n`;
  await writeFile(join(input, 'package.json'), JSON.stringify({ name: 'ccdd-review-input', private: true, type: 'module' }));
  await writeFile(join(input, 'spec.md'), sample);
  await writeFile(join(input, 'ccdd.config.ts'), fixtureConfig(withDefaults));
  await writeFile(join(input, 'checks/release.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\ntest('read the copied synthetic Artifact', async () => assert.equal(await readFile(new URL('../spec.md', import.meta.url), 'utf8'), ${JSON.stringify(sample)}));\n`);
  await command('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true'], { cwd: project, env: environment });
  const dependencyTree = await jsonCommand('npm', ['ls', '--omit=dev', '--depth=0', '--json'], { cwd: project, env: environment });
  assert.deepEqual(Object.keys(dependencyTree.dependencies).sort(), Object.keys(dependencies).sort());
  for (const packageName of Object.keys(dependencies)) {
    assert.equal(dependencyTree.dependencies[packageName].version, version);
    const manifest = JSON.parse(await readFile(join(project, 'node_modules', packageName, 'package.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.equal((await lstat(join(project, 'node_modules', packageName))).isSymbolicLink(), false, 'Installed packages must not link back to the source checkout');
  }
  if (!withDefaults) await assert.rejects(lstat(join(project, 'node_modules', toolsName)), { code: 'ENOENT' });
  for (const devPackage of ['typescript', 'typescript-ui', 'vite', 'vue-tsc']) await assert.rejects(lstat(join(project, 'node_modules', devPackage)), { code: 'ENOENT' });
  // The application install is outside the reviewed input, like a global CLI install.
  // Include exact installed SDK/tool files used by this text-only config inside the input.
  // Nothing inside the reviewed input is excluded from snapshot capture or hashing.
  for (const name of [coreName, ...(withDefaults ? [toolsName] : [])]) await cp(join(project, 'node_modules', name), join(input, 'node_modules', name), { recursive: true });
  const cli = join(project, 'node_modules', projectName, 'dist/src/cli.js');
  const projectCli = join(project, 'node_modules', projectName, 'dist/src/project/cli.js');
  assert.match((await command('npm', ['exec', '--offline', '--', 'ccdd-project', 'help'], { cwd: project, env: environment })).stdout, /CCDD Project/);
  assert.match((await command(cli, ['help'], { cwd: project, env: environment })).stdout, new RegExp(`^CCDD ${version.replaceAll('.', '\\.')} —`, 'm'));
  const toolName = withDefaults ? 'read_spec' : 'inspect_spec';
  const report = await jsonCommand(cli, ['tools', 'check', '--repo', input, '--state-dir', state, '--artifact', 'spec', '--for', 'agent', '--tool', toolName, '--execute', '--copy', '--args', withDefaults ? '{"startLine":2,"lineCount":1}' : '{}', '--json'], { cwd: project, env: environment });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.status, 'READY');
  assert.equal(report.mode, 'copy');
  assert.equal(report.tools.length, 1);
  assert.equal(report.tools[0].name, toolName);
  assert.ok(within(state, report.workspacePath) && !within(project, report.workspacePath), 'Tool execution must use an independent copied workspace');
  assert.equal(await readFile(join(report.workspacePath, 'spec.md'), 'utf8'), sample);
  assert.equal(await readFile(join(input, 'spec.md'), 'utf8'), sample);
  const content = report.result?.content;
  assert.ok(Array.isArray(content) && content.length === 1, 'Expected an actual tool result');
  if (withDefaults) {
    assert.equal(content[0].type, 'json');
    assert.equal(content[0].data.content, 'Second line.\n');
    assert.equal(content[0].data.startLine, 2);
    assert.equal(content[0].data.lineCount, 1);
  } else {
    assert.equal(content[0].type, 'text');
    assert.equal(content[0].text, sample);
  }
  let runtime = undefined;
  if (withDefaults) {
    const run = await jsonCommand(cli, ['run', '--repo', input, '--state-dir', state, '--critic', 'package-runtime', '--copy', '--wait', '--timeout-ms', '120000'], { cwd: project, env: environment });
    assert.equal(run.status, 'GREEN', 'The installed detached Runtime worker must finish the actual test');
    runtime = 'GREEN';
  }
  const validationArgs = ['verify', '--critic', 'package-runtime', '--repo', input, '--state-dir', state, '--wait', '--timeout-ms', '120000', '--json'];
  const reviewed = await jsonCommand(projectCli, validationArgs, { cwd: project, env: environment });
  assert.equal(reviewed.status, 'GREEN'); assert.equal(reviewed.requests.length, 1);
  const reused = await jsonCommand(projectCli, validationArgs, { cwd: project, env: environment });
  assert.equal(reused.status, 'GREEN'); assert.equal(reused.requests.length, 0); assert.equal(reused.validation.counts.reuse, 1);
  return { name, productionInstall: true, installScripts: false, cliHelpVersion: version, defaultToolsInstalled: withDefaults, tool: toolName, actualToolExecution: true, workspaceMode: 'copy', projectValidation: true, ...(runtime ? { runtime } : {}) };
}

async function removeScratch(directory) {
  // The copied test workspaces are deliberately readonly. This is only our own mkdtemp tree.
  async function writable(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await writable(join(path, entry));
  }
  await writable(directory);
  await rm(directory, { recursive: true, force: true });
}

export async function verifyRelease(argv) {
  const options = parseArguments(argv);
  assert.ok(supportsNodeVersion(process.versions.node), `Release verification requires ${nodeRequirement}`);
  const version = options['--version'];
  const sourceCommit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(sourceCommit, options['--source-commit'], 'Source commit differs from the checked-out HEAD');
  assert.equal((await command('git', ['status', '--porcelain', '--untracked-files=all'])).stdout.trim(), '', 'Commit all source changes before release verification; ignored build outputs are allowed');
  for (const path of ['package.json', 'packages/default-tools/package.json', 'packages/project/package.json']) assert.equal(JSON.parse(await readFile(join(sourceDirectory, path), 'utf8')).version, version, `${path} version differs from release version`);
  const lock = JSON.parse(await readFile(join(sourceDirectory, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, version, 'Lockfile root version differs');
  assert.equal(lock.packages[''].version, version, 'Lockfile core version differs');
  assert.equal(lock.packages['packages/default-tools'].version, version, 'Lockfile default-tools version differs');
  assert.equal(lock.packages['packages/project'].version, version, 'Lockfile project version differs');
  const testBytes = await readFile(resolve(options['--test-report']));
  const tests = readTestSummary(testBytes.toString('utf8'));
  const outputDirectory = resolve(options['--output-dir']);
  assert.ok(!within(sourceDirectory, outputDirectory), 'Release output must be outside the source checkout');
  await mkdir(outputDirectory, { recursive: true });
  assert.equal(await realpath(outputDirectory), outputDirectory, 'Release output path must be canonical, without symlinks');
  assert.deepEqual(await readdir(outputDirectory), [], 'Release output directory must be empty');
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-release-verification-')));
  const npmrc = join(scratch, 'empty.npmrc');
  const globalNpmrc = join(scratch, 'global.npmrc');
  await writeFile(npmrc, '');
  await writeFile(globalNpmrc, '');
  // Only public dependencies are downloaded. Provider credentials and npm auth are not inherited.
  const environment = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'CI'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(environment, {
    npm_config_registry: 'https://registry.npmjs.org/', npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc, npm_config_ignore_scripts: 'true',
    npm_config_cache: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || join(scratch, 'npm-cache'),
  });
  try {
    console.log('Packing built release packages and checking archive contents…');
    const packages = [];
    packages.push(await packPackage(sourceDirectory, coreName, version, outputDirectory, environment));
    packages.push(await packPackage(join(sourceDirectory, 'packages/default-tools'), toolsName, version, outputDirectory, environment));
    packages.push(await packPackage(join(sourceDirectory, 'packages/project'), projectName, version, outputDirectory, environment));
    const installations = [];
    for (const withDefaults of [true, false]) {
      console.log(`Verifying production installation: ${withDefaults ? 'core + default tools' : 'core only + custom tool'}…`);
      installations.push(await verifyInstallation({ scratch, outputDirectory, packages, version, withDefaults, environment }));
    }
    assert.equal((await command('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceCommit, 'Source commit changed during release verification');
    assert.equal((await command('git', ['status', '--porcelain', '--untracked-files=all'])).stdout.trim(), '', 'Source checkout changed during release verification');
    const verification = {
      schemaVersion: 1, status: 'PASS', version, tag: options['--tag'], sourceCommit,
      node: process.version, npm: (await command('npm', ['--version'], { env: environment })).stdout.trim(), platform: process.platform, architecture: process.arch,
      tests: { total: tests.tests, passed: tests.pass, failed: tests.fail, cancelled: tests.cancelled, skipped: tests.skipped, todo: tests.todo, reportSha256: sha256(testBytes) }, packages, installations,
      providerCalls: false, desktopLaunches: false,
    };
    const report = `${JSON.stringify(verification, null, 2)}\n`;
    await writeFile(join(outputDirectory, 'verification.json'), report);
    const sums = [...packages.map(pkg => `${pkg.sha256}  ${pkg.file}`), `${sha256(report)}  verification.json`].join('\n') + '\n';
    await writeFile(join(outputDirectory, 'SHA256SUMS'), sums);
    console.log(JSON.stringify({ status: 'PASS', version, tag: options['--tag'], sourceCommit, packages: packages.map(pkg => pkg.file), tests: tests.tests }));
    return verification;
  } finally {
    await removeScratch(scratch);
  }
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyRelease(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
