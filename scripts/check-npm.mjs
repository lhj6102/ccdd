#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { supportsNodeVersion } from '../src/node-version.ts';

const exec = promisify(execFile);
const registry = 'https://registry.npmjs.org/';

async function npmRead(args, environment) {
  const cache = await mkdtemp(join(tmpdir(), 'ccdd-npm-check-'));
  try {
    const { stdout } = await exec('npm', [...args, '--json', `--registry=${registry}`, `--@ccdd:registry=${registry}`, `--cache=${cache}`, '--logs-max=0'], {
      cwd: tmpdir(), env: environment, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    return args[0] === '--version' ? stdout.trim() : JSON.parse(stdout);
  } catch (error) {
    let code;
    try { code = JSON.parse(error.stdout).error?.code; } catch { /* Only retain a safe error code. */ }
    const failure = new Error(`npm ${args.slice(0, 2).join(' ')} could not be checked`);
    failure.code = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'CHECK_FAILED';
    throw failure;
  } finally { await rm(cache, { recursive: true, force: true }); }
}

// All requests are read-only; the result contains no tokens, email or raw profile.
export async function checkNpmEnvironment({ environment = process.env, nodeVersion = process.version, read = args => npmRead(args, environment) } = {}) {
  const checks = [{ id: 'node', ok: supportsNodeVersion(nodeVersion), detail: nodeVersion }];
  let npm, account, role, twoFactor, emailVerified;
  try { npm = await read(['--version']); checks.push({ id: 'npm', ok: true, detail: npm }); }
  catch (error) { checks.push({ id: 'npm', ok: false, detail: error.code }); }
  try {
    account = await read(['whoami']);
    if (typeof account !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(account)) throw new Error('Invalid npm account');
    checks.push({ id: 'login', ok: true, detail: account });
  } catch (error) { account = undefined; checks.push({ id: 'login', ok: false, detail: error.code ?? 'CHECK_FAILED' }); }
  if (account) {
    try {
      const profile = await read(['profile', 'get']);
      twoFactor = profile.tfa?.pending ? 'pending' : profile.tfa?.mode ?? 'disabled';
      emailVerified = profile.email_verified === true;
      checks.push({ id: 'profile', ok: profile.name === account && emailVerified, detail: emailVerified ? 'Email verified' : 'Email verification required' });
    } catch (error) { checks.push({ id: 'profile', ok: false, detail: error.code }); }
    try {
      const members = await read(['org', 'ls', 'ccdd']);
      role = members[account] ?? null;
      checks.push({ id: 'scope', ok: ['owner', 'admin', 'developer', 'member'].includes(role), detail: role ?? 'No membership in @ccdd was confirmed' });
    } catch (error) {
      checks.push({ id: 'scope', ok: false, detail: error.code === 'E404' ? 'Scope not found: @ccdd organization is unavailable to this account' : error.code });
    }
  }
  return { status: checks.every(check => check.ok) ? 'READY' : 'NOT_READY', checkedAt: new Date().toISOString(), registry,
    node: nodeVersion, npm, account, scope: '@ccdd', role, twoFactor, emailVerified, checks,
    publicationVerified: false };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('Usage: npm run release:npm:check'); process.exitCode = 1; }
  else {
    const report = await checkNpmEnvironment();
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'READY') process.exitCode = 1;
  }
}
