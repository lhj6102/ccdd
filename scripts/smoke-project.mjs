import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPackage, verifyInstallation, verifyUmbrellaInstallation, packageDirectories } from './verify-release.mjs';
import { removeOwnedWorkspaceTree } from '../dist/src/workspaces/index.js';

// Local verification of built tarballs; no publication or clean-commit requirement.
const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-package-smoke-')));
const outputDirectory = join(scratch, 'packages'); await mkdir(outputDirectory);
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const npmrc = join(scratch, 'user.npmrc'), globalNpmrc = join(scratch, 'global.npmrc');
await writeFile(npmrc, ''); await writeFile(globalNpmrc, '');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|TMP|TEMP|TMPDIR|SYSTEMROOT|COMSPEC)$/i.test(key)));
Object.assign(environment, { npm_config_userconfig: npmrc, npm_config_globalconfig: globalNpmrc, npm_config_ignore_scripts: 'true', npm_config_registry: 'https://registry.npmjs.org/', npm_config_cache: join(root, 'output/npm-cache') });
if (process.env.CCDD_PACKAGE_SMOKE_OFFLINE === '1') environment.npm_config_offline = 'true';
try {
  const packages = [];
  for (const [directory, name] of packageDirectories) {
    packages.push(await packPackage(join(root, directory), name, version, outputDirectory, environment));
  }
  assert.equal(packages.length, packageDirectories.length);
  const installations = [];
  for (const withDefaults of [true, false]) {
    console.log(`Checking installed Project with ${withDefaults ? 'default' : 'custom'} tools…`);
    installations.push(await verifyInstallation({ scratch, outputDirectory, packages, version, withDefaults, environment }));
  }
  for (const manager of ['npm', 'pnpm']) installations.push(await verifyUmbrellaInstallation({ scratch, outputDirectory, packages, version, environment, manager }));
  console.log(JSON.stringify({ status: 'PASS', packages: packages.map(p => p.name), installations }, null, 2));
} finally { await removeOwnedWorkspaceTree(scratch); }
