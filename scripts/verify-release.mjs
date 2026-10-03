#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nodeRequirement, supportedNodeRange, supportsNodeVersion } from '../src/node-version.ts';
import { readReleaseMetadata, validateAssets, packedManifest } from './release.mjs';

const exec = promisify(execFile);
const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreName = '@ccdd/core';
const toolsName = '@ccdd/default-tools';
const projectName = '@ccdd/project';
const umbrellaName = '@ccdd/ccdd';
export const packageDirectories = [['', coreName], ['packages/default-tools', toolsName], ['packages/project', projectName], ['packages/ccdd', umbrellaName]];
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
  if (![coreName, toolsName, projectName, umbrellaName].includes(packageName)) return false;
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) return false;
  if (path.split('/').some(part => /^(?:node_modules|output|worktrees?|snapshots?|state|sources|\.git|\.ccdd|\.codex|\.ssh|\.aws|\.npmrc)$/i.test(part))) return false;
  if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials(?:\.[^/]*)?)$/i.test(path) || /\.(?:db|sqlite(?:3)?|pem|key|tgz|zip)$/i.test(path)) return false;
  if (/^(?:package\.json|README\.md|LICENSE(?:\.[A-Za-z]+)?)$/.test(path)) return true;
  if (packageName === umbrellaName) return /^dist\/(?:core|project|tools|cli|view|pi|pi-providers)\.(?:js|js\.map|d\.ts)$/.test(path);
  if (packageName === toolsName) return /^dist\/.+\.(?:js|js\.map|d\.ts)$/.test(path) || /^examples\/.+\.(?:md|json)$/.test(path);
  if (packageName === coreName) return /^dist\/src\/(?:sdk|definitions|artifact-scope|tools\/contracts)\.(?:js|js\.map|d\.ts)$/.test(path) || /^examples\/.+\.(?:md|ts|mjs|json|png|jpg|jpeg|webp)$/.test(path);
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
    ? ['dist/src/sdk.js', 'dist/src/sdk.d.ts', 'dist/src/definitions.d.ts', 'dist/src/tools/contracts.d.ts', 'examples/custom-text-reader/spec/ccdd.json']
    : expectedName === umbrellaName ? ['dist/core.js', 'dist/core.d.ts', 'dist/project.js', 'dist/tools.js', 'dist/cli.js', 'dist/view.js', 'dist/pi.js', 'dist/pi.d.ts', 'dist/pi-providers.js', 'dist/pi-providers.d.ts']
    : expectedName === projectName ? ['dist/src/cli.js', 'dist/src/project/cli.js', 'dist/src/project/index.js', 'dist/src/worker.js', 'dist/scripts/prepare-demo.js', 'dist/monitor-ui/index.html']
    : ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/script.js', 'dist/reader.js', 'dist/process.js'];
  if (expectedName === coreName) { assert.equal(manifest.bin, undefined); assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0); }
  for (const path of required) assert.ok(paths.includes(path), `Missing packaged runtime file: ${path}`);
  const bytes = await readFile(tarball);
  return { name: expectedName, version, file: metadata.filename, bytes: bytes.length, sha256: sha256(bytes), fileCount: paths.length };
}

function fixtureConfig(withDefaults) {
  const tool = withDefaults ? 'read' : 'inspect';
  return JSON.stringify({
    name: 'spec',
    views: { agentTools: { [tool]: {
      metadata: {
        description: 'Read the supplied Artifact document.',
        inputSchema: { type: 'object', properties: withDefaults ? {
          path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, lineCount: { type: 'integer', minimum: 1 },
        } : {}, ...(withDefaults ? { required: ['path'] } : {}), additionalProperties: false },
        resultKinds: [withDefaults ? 'json' : 'text'], observation: 'content',
        ...(withDefaults ? { executionPaths: ['node_modules/@ccdd/default-tools/dist', 'node_modules/@ccdd/core/dist'] } : {}),
      },
      script: { command: 'node', args: withDefaults ? ['node_modules/@ccdd/default-tools/dist/script.js', 'read'] : ['view.mjs'] },
    } } },
    critics: [{ id: 'package-runtime', title: 'Packaged runtime verification',
      profile: { kind: 'runtime', command: 'node', args: ['--test', 'checks/release.test.mjs'] },
      payload: { instruction: 'Run the synthetic package test for {spec}.' } }],
  }, null, 2);
}

export async function verifyInstallation({ scratch, outputDirectory, packages, version, withDefaults, environment }) {
  const name = withDefaults ? 'core-and-default-tools' : 'core-only-custom-tool';
  environment = { ...environment, CCDD_STATE_HOME: join(scratch, `${name}-machine-state`) };
  const project = join(scratch, name);
  const input = join(project, 'review-input');
  const state = join(scratch, `${name}-state`);
  await mkdir(join(input, 'checks'), { recursive: true });
  const dependencies = Object.fromEntries(packages.filter(pkg => pkg.name !== umbrellaName && (withDefaults || pkg.name !== toolsName)).map(pkg => [pkg.name, `file:${join(outputDirectory, pkg.file)}`]));
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: `ccdd-release-${name}`, private: true, type: 'module', dependencies }, null, 2));
  const sample = `CCDD ${version} package verification.\nSecond line.\n`;
  await writeFile(join(input, 'package.json'), JSON.stringify({ name: 'ccdd-review-input', private: true, type: 'module' }));
  await writeFile(join(input, 'spec.md'), sample);
  await writeFile(join(input, 'ccdd.json'), fixtureConfig(withDefaults));
  if (!withDefaults) await writeFile(join(input, 'view.mjs'), `import {readFile} from 'node:fs/promises';
let input='';for await(const chunk of process.stdin) input+=chunk;
const request=JSON.parse(input);if(request.version!==1)throw new Error('Unsupported request');
const text=await readFile(new URL('./spec.md',import.meta.url),'utf8');
process.stdout.write(JSON.stringify({content:[{type:'text',text}],observation:{kind:'content'}}));
`);
  await writeFile(join(input, 'checks/release.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\ntest('read the supplied fixture Artifact', async () => assert.equal(await readFile(new URL('../spec.md', import.meta.url), 'utf8'), ${JSON.stringify(sample)}));\n`);
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
  // Include exact installed SDK/tool files used by these folder declarations inside the input.
  // Nothing inside the reviewed input is excluded from whole-workspace integrity checks.
  for (const name of [coreName, ...(withDefaults ? [toolsName] : [])]) await cp(join(project, 'node_modules', name), join(input, 'node_modules', name), { recursive: true });
  const cli = join(project, 'node_modules', projectName, 'dist/src/cli.js');
  const projectCli = join(project, 'node_modules', projectName, 'dist/src/project/cli.js');
  assert.match((await command('npm', ['exec', '--offline', '--', 'ccdd-project', 'help'], { cwd: project, env: environment })).stdout, /CCDD Project/);
  assert.match((await command(cli, ['help'], { cwd: project, env: environment })).stdout, /CCDD Project/);
  const toolName = withDefaults ? 'read_spec' : 'inspect_spec';
  const report = await jsonCommand(cli, ['tools', 'check', '--repo', input, '--state-dir', state, '--artifact', 'spec', '--for', 'agent', '--tool', toolName, '--execute', '--args', withDefaults ? '{"path":"spec.md","startLine":2,"lineCount":1}' : '{}', '--json'], { cwd: project, env: environment });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.status, 'READY');
  assert.equal(Object.hasOwn(report, 'mode'), false);
  assert.equal(report.tools.length, 1);
  assert.equal(report.tools[0].name, toolName);
  assert.equal(report.workspacePath, await realpath(input), 'Tool execution must use the supplied workspace');
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
  const validationArgs = ['verify', '--critic', 'spec/package-runtime', '--repo', input, '--state-dir', state, '--wait', '--timeout-ms', '120000', '--json'];
  const reviewed = await jsonCommand(projectCli, validationArgs, { cwd: project, env: environment });
  assert.equal(reviewed.status, 'GREEN'); assert.equal(reviewed.requests.length, 1);
  await verifyInstalledCacheContract({ cli: projectCli, args: validationArgs, input, state, project, environment });
  const examples = [];
  for (const [example, artifact, tool, args] of [
    ['custom-text-reader', 'spec', 'read', { startLine: 1, lineCount: 20 }],
    ['computed-views', 'checkout', 'overview', {}],
    ['artifact-families', 'search', 'detail', { id: 'query' }],
    ...(withDefaults ? [['artifact-folders', 'explosion', 'blind_pair', {}]] : []),
  ]) {
    const examplePath = join(project, `example-${example}`), exampleState = join(scratch, `${name}-${example}-state`);
    await cp(join(project, 'node_modules', coreName, 'examples', example), examplePath, { recursive: true });
    if (example === 'artifact-folders') {
      for (const packageName of [coreName, toolsName]) await cp(join(project, 'node_modules', packageName), join(examplePath, 'node_modules', packageName), { recursive: true });
      await mkdir(join(examplePath, 'node_modules/.bin'), { recursive: true });
      await cp(join(project, 'node_modules/.bin/ccdd-view'), join(examplePath, 'node_modules/.bin/ccdd-view'), { verbatimSymlinks: true });
    }
    const common = ['--repo', examplePath, '--state-dir', exampleState, '--json'];
    assert.equal((await jsonCommand(cli, ['config', 'check', ...common], { cwd: project, env: environment })).ok, true);
    const observed = await jsonCommand(cli, ['tools', 'check', '--artifact', artifact, '--for', 'agent', '--tool', tool, '--execute', '--args', JSON.stringify(args), ...common], { cwd: project, env: environment });
    assert.equal(observed.ok, true, JSON.stringify(observed.checks));
    assert.ok(observed.result.content.length > 0);
    if (example === 'artifact-folders') {
      assert.equal(observed.result.content.filter(block => block.type === 'image').length, 2);
      assert.doesNotMatch(JSON.stringify(observed.result), /theme\.png|preview\.png|pair-map/);
      const read = await jsonCommand(cli, ['tools', 'check', '--artifact', 'effect', '--for', 'agent', '--tool', 'read', '--execute', '--args', '{"path":"effect.md"}', ...common], { cwd: project, env: environment });
      assert.equal(read.ok, true, JSON.stringify(read.checks));
      assert.equal(read.result.content[0].type, 'json');
    }
    examples.push(example);
  }
  return { name, productionInstall: true, installScripts: false, cliHelpVersion: version, defaultToolsInstalled: withDefaults, tool: toolName, actualToolExecution: true, workspace: 'in-place', projectValidation: true, runtime: 'GREEN', examples };
}

/** Exercise the public installed CLI, not internal cache helpers or invented evidence. */
async function verifyInstalledCacheContract({ cli, args, input, state, project, environment }) {
  const invoke = argv => jsonCommand(cli, argv, { cwd: project, env: environment });
  const uncached = await invoke(args);
  assert.equal(uncached.status, 'GREEN');
  assert.equal(uncached.requests.length, 1, 'No identity must execute again.');
  assert.equal(uncached.validation.counts.reuse, 0);
  const declaration = JSON.parse(await readFile(join(input, 'ccdd.json'), 'utf8'));
  declaration.stale = { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } };
  await writeFile(join(input, 'identity.mjs'), `import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';const hash=createHash('sha256');for(const path of ['ccdd.json','spec.md'])hash.update(await readFile(new URL(path,import.meta.url)));console.log(hash.digest('hex'));\n`);
  await writeFile(join(input, 'ccdd.json'), JSON.stringify(declaration));
  const actual = await invoke(args);
  assert.equal(actual.status, 'GREEN'); assert.equal(actual.requests.length, 1);
  assert.equal(actual.requests[0].cacheDisposition, 'executed');
  const reused = await invoke([...args, '--max-executions', '0']);
  assert.equal(reused.status, 'GREEN'); assert.equal(reused.requests[0].cacheDisposition, 'hit');
  assert.equal(reused.requests[0].executionSource.executionId, actual.requests[0].executionSource.executionId);
  const copy = `${input}-independent`, copyState = `${state}-independent`;
  await cp(input, copy, { recursive: true });
  await removeScratch(input); await removeScratch(state);
  const crossRepoArgs = args.map((value, i) => args[i - 1] === '--repo' ? copy : args[i - 1] === '--state-dir' ? copyState : value);
  const crossRepo = await invoke([...crossRepoArgs, '--max-executions', '0']);
  assert.equal(crossRepo.status, 'GREEN'); assert.equal(crossRepo.requests[0].cacheDisposition, 'hit');
  assert.equal(crossRepo.requests[0].executionSource.executionId, actual.requests[0].executionSource.executionId);
  const stored = await invoke(['cache', 'show', actual.requests[0].inputKey, '--json']);
  assert.equal(stored.result.verdict, 'GREEN');
  assert.equal(stored.executionId, actual.requests[0].executionSource.executionId);
}

/** Install only the umbrella against exact tarballs, without rewriting their dependencies. */
export async function verifyUmbrellaInstallation({ scratch, outputDirectory, packages, version, environment, manager }) {
  const { createServer } = await import('node:http');
  const name = `umbrella-${manager}`, project = join(scratch, name), input = join(project, 'review-input'), state = join(scratch, `${name}-state`);
  await mkdir(input, { recursive: true });
  const packed = new Map();
  for (const pkg of packages) packed.set(pkg.name, { ...pkg, bytes: await readFile(join(outputDirectory, pkg.file)) });
  let origin;
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, origin).pathname).slice(1);
      const item = [...packed.values()].find(pkg => pkg.file === pathname || pkg.name === pathname);
      if (!item) { response.writeHead(404); response.end('Not found'); return; }
      if (pathname === item.file) { response.setHeader('content-type', 'application/octet-stream'); response.end(item.bytes); return; }
      const manifest = packedManifest(item.bytes);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: item.name, 'dist-tags': { latest: version }, versions: { [version]: { ...manifest, dist: { tarball: `${origin}/${item.file}`, integrity: `sha512-${createHash('sha512').update(item.bytes).digest('base64')}` } } } }));
    } catch { response.writeHead(500); response.end('Fixture registry failure'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...environment, CCDD_STATE_HOME: join(scratch, `${name}-machine-state`), PATH: `${join(project, 'node_modules/.bin')}${delimiter}${environment.PATH ?? ''}` };
  const pnpm = join(sourceDirectory, 'node_modules/pnpm/bin/pnpm.cjs');
  const runManager = args => manager === 'npm' ? command('npm', args, { cwd: project, env }) : command(process.execPath, [pnpm, ...args], { cwd: project, env });
  try {
    await writeFile(join(project, 'package.json'), JSON.stringify({ name, private: true, type: 'module', dependencies: { [umbrellaName]: version } }, null, 2));
    await writeFile(join(project, '.npmrc'), `@ccdd:registry=${origin}/\nignore-scripts=true\nauto-install-peers=false\nstrict-peer-dependencies=true\nhoist=false\nnode-linker=isolated\n`);
    await runManager(manager === 'npm' ? ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--prod', '--ignore-scripts', '--store-dir', join(scratch, 'pnpm-store')]);
    const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies), [umbrellaName]);
    if (manager === 'pnpm') for (const dependency of [coreName, projectName, toolsName]) await assert.rejects(lstat(join(project, 'node_modules', dependency)), { code: 'ENOENT' });
    await writeFile(join(project, 'imports.mjs'), `import assert from 'node:assert/strict';import * as root from '@ccdd/ccdd';import * as core from '@ccdd/ccdd/core';import {createBroker,openIdentityCache,prepareProject,streamProjectResults,projectRunSummary,compareProjectRuns,providerStatus} from '@ccdd/ccdd/project';import {agent,scriptRequest} from '@ccdd/ccdd/tools';assert.equal(root.resolveScopePath,core.resolveScopePath);for(const fn of [createBroker,openIdentityCache,prepareProject,streamProjectResults,projectRunSummary,compareProjectRuns,providerStatus])assert.equal(typeof fn,'function');assert.equal(typeof agent.text.read,'function');assert.equal(typeof scriptRequest,'function');globalThis.fetch=()=>{throw Error('No network allowed in catalog exposure check')};const {getSupportedThinkingLevels}=await import('@ccdd/ccdd/pi');const {builtinModels,builtinProviders}=await import('@ccdd/ccdd/pi/providers/all');const models=builtinModels();for(const name of ['getProviders','getModels','getModel','checkAuth','login','logout','streamSimple'])assert.equal(typeof models[name],'function');assert.ok(builtinProviders().some(p=>p.id==='opencode-go'));assert.equal(models.getModel('opencode-go','deepseek-v4.1-flash').id,'deepseek-v4.1-flash');assert.ok(getSupportedThinkingLevels(models.getModel('openai-codex','gpt-6-luna')).includes('xhigh'));`);
    await command(process.execPath, [join(project, 'imports.mjs')], { cwd: project, env });
    await writeFile(join(project, 'imports.ts'), `import type {ArtifactManifest} from '@ccdd/ccdd';import type {ToolResult} from '@ccdd/ccdd/core';import {createBroker,openIdentityCache,prepareProject,streamProjectResults,projectRunSummary,compareProjectRuns,providerStatus} from '@ccdd/ccdd/project';import {agent,scriptRequest} from '@ccdd/ccdd/tools';const artifact:ArtifactManifest={name:'test'};const result:ToolResult={content:[]};import type {Models,AuthInteraction,CredentialStore} from '@ccdd/ccdd/pi';import {builtinModels,builtinProviders} from '@ccdd/ccdd/pi/providers/all';const models:Models=builtinModels();type Interaction=AuthInteraction;type Store=CredentialStore;void [artifact,result,createBroker,openIdentityCache,prepareProject,streamProjectResults,projectRunSummary,compareProjectRuns,providerStatus,agent,scriptRequest,models,builtinProviders];`);
    await command(process.execPath, [join(sourceDirectory, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext', join(project, 'imports.ts')], { cwd: project, env });
    for (const bin of ['ccdd', 'ccdd-project']) assert.match((await runManager(manager === 'npm' ? ['exec', '--offline', '--', bin, 'help'] : ['exec', bin, 'help'])).stdout, /CCDD Project/);
    await writeFile(join(project, 'forwarding.mjs'), `import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';const exec=promisify(execFile);const cli=new URL('./node_modules/@ccdd/ccdd/dist/cli.js',import.meta.url).pathname;try{await exec(process.execPath,[cli,'not-a-command','--json']);assert.fail('Unknown command must fail');}catch(error){assert.equal(error.code,2);assert.equal(typeof JSON.parse(error.stdout).error,'string');}`);
    await command(process.execPath, [join(project, 'forwarding.mjs')], { cwd: project, env });
    await writeFile(join(input, 'spec.md'), 'Umbrella installation fixture.\nSecond line.\n');
    await writeFile(join(input, 'view.mjs'), `import {scriptRequest} from '@ccdd/ccdd/tools';let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.stringify(await scriptRequest('read',JSON.parse(text))));`);
    await writeFile(join(input, 'check.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';test('actual umbrella arithmetic',()=>assert.equal(2+3,5));`);
    const metadata = { description: 'Read the fixture.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, resultKinds: ['json'], observation: 'content' };
    await writeFile(join(input, 'ccdd.json'), JSON.stringify({ name: 'spec', views: { agentTools: {
      defaults: { metadata, script: { command: 'ccdd-view', args: ['read'] } },
      custom: { metadata, script: { command: 'node', args: ['view.mjs'] } },
    } }, critics: [{ id: 'runtime', title: 'Actual test', profile: { kind: 'runtime', command: 'node', args: ['--test', 'check.test.mjs'] }, payload: { instruction: 'Run the real test.' } }] }));
    const cli = join(project, 'node_modules/@ccdd/ccdd/dist/cli.js');
    for (const tool of ['defaults_spec', 'custom_spec']) {
      const report = await jsonCommand(cli, ['tools', 'check', '--repo', input, '--state-dir', state, '--artifact', 'spec', '--for', 'agent', '--tool', tool, '--execute', '--args', '{"path":"spec.md"}', '--json'], { cwd: project, env });
      assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.result.content[0].data.content, 'Umbrella installation fixture.\nSecond line.\n');
    }
    const args = ['verify', '--repo', input, '--state-dir', state, '--critic', 'spec/runtime', '--wait', '--json'];
    const actual = await jsonCommand(cli, args, { cwd: project, env }); assert.equal(actual.status, 'GREEN');
    await verifyInstalledCacheContract({ cli, args, input, state, project, environment: env });
    return { name, productionInstall: true, installScripts: false, onlyDirectDependency: umbrellaName, cliHelpVersion: version, publicImports: true, typeImports: true, piPublicApi: true, defaultToolExecution: true, customToolExecution: true, binExecution: true, runtime: 'GREEN', projectValidation: true };
  } finally { await new Promise(resolve => server.close(resolve)); }
}

async function removeScratch(directory) {
  // Clean only the temporary installation and test workspace owned by this verifier.
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
  for (const path of packageDirectories.map(([directory]) => join(directory, 'package.json'))) assert.equal(JSON.parse(await readFile(join(sourceDirectory, path), 'utf8')).version, version, `${path} version differs from release version`);
  const lock = JSON.parse(await readFile(join(sourceDirectory, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, version, 'Lockfile root version differs');
  assert.equal(lock.packages[''].version, version, 'Lockfile core version differs');
  assert.equal(lock.packages['packages/default-tools'].version, version, 'Lockfile default-tools version differs');
  assert.equal(lock.packages['packages/project'].version, version, 'Lockfile project version differs');
  assert.equal(lock.packages['packages/ccdd'].version, version, 'Lockfile umbrella version differs');
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
    for (const [directory, name] of packageDirectories) packages.push(await packPackage(join(sourceDirectory, directory), name, version, outputDirectory, environment));
    const installations = [];
    for (const withDefaults of [true, false]) {
      console.log(`Verifying production installation: ${withDefaults ? 'core + default tools' : 'core only + custom tool'}…`);
      installations.push(await verifyInstallation({ scratch, outputDirectory, packages, version, withDefaults, environment }));
    }
    for (const manager of ['npm', 'pnpm']) installations.push(await verifyUmbrellaInstallation({ scratch, outputDirectory, packages, version, environment, manager }));
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
    await validateAssets(outputDirectory, await readReleaseMetadata(sourceDirectory), sourceCommit);
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
