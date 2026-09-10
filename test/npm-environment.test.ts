import test from 'node:test';
import assert from 'node:assert/strict';

const { checkNpmEnvironment } = await import(new URL('../../scripts/check-npm.mjs', import.meta.url).href);

function reader(scope: Record<string, string> | Error = { maintainer: 'owner' }) {
  const calls: string[] = [];
  return {
    calls,
    async read(args: string[]) {
      const command = args.join(' '); calls.push(command);
      if (command === '--version') return '11.16.0';
      if (command === 'whoami') return 'maintainer';
      if (command === 'profile get') return { name: 'maintainer', email_verified: true, email: 'private-sentinel@example.invalid', token: 'private-sentinel-token', tfa: { mode: 'auth-and-writes', pending: null } };
      if (command === 'org ls ccdd') { if (scope instanceof Error) throw scope; return scope; }
      assert.fail(`Unexpected npm command: ${command}`);
    },
  };
}

test('npm environment inspection uses read-only commands and redacts profile details', async () => {
  const data = reader(), report = await checkNpmEnvironment({ read: data.read, nodeVersion: 'v24.18.0' });
  assert.equal(report.status, 'READY'); assert.equal(report.account, 'maintainer');
  assert.equal(report.role, 'owner'); assert.equal(report.twoFactor, 'auth-and-writes');
  assert.equal(report.publicationVerified, false);
  assert.doesNotMatch(JSON.stringify(report), /private-sentinel/);
  assert.deepEqual(data.calls, ['--version', 'whoami', 'profile get', 'org ls ccdd']);
});

test('missing scope and absent membership cannot pass npm preflight', async () => {
  for (const scope of [Object.assign(new Error('sensitive response'), { code: 'E404' }), {}]) {
    const data = reader(scope), report = await checkNpmEnvironment({ read: data.read, nodeVersion: 'v24.18.0' });
    assert.equal(report.status, 'NOT_READY');
    assert.equal(report.checks.find((check: { id: string }) => check.id === 'scope').ok, false);
    assert.doesNotMatch(JSON.stringify(report), /sensitive/);
  }
});

test('npm preflight accepts supported Node versions and rejects older or prerelease runtimes', async () => {
  for (const nodeVersion of ['v22.19.0', 'v22.22.0', 'v24.0.0', 'v24.18.0', 'v26.0.0']) {
    assert.equal((await checkNpmEnvironment({ read: reader().read, nodeVersion })).status, 'READY', nodeVersion);
  }
  for (const nodeVersion of ['v20.19.0', 'v22.0.0', 'v22.18.0', 'v23.11.0', 'v22.19.0-rc.1', 'invalid']) {
    assert.equal((await checkNpmEnvironment({ read: reader().read, nodeVersion })).status, 'NOT_READY', nodeVersion);
  }
});

test('failed npm authentication stops account and organization inspection', async () => {
  const calls: string[] = [];
  const report = await checkNpmEnvironment({ nodeVersion: 'v24.18.0', read: async (args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === '--version') return '11.16.0';
    throw Object.assign(new Error('private-sentinel'), { code: 'ENEEDAUTH' });
  } });
  assert.equal(report.status, 'NOT_READY');
  assert.deepEqual(calls, ['--version', 'whoami']);
  assert.doesNotMatch(JSON.stringify(report), /private-sentinel/);
});
