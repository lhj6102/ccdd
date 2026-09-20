import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const registryUrl = new URL('../src/executors/index.js', import.meta.url).href;
const cliUrl = new URL('../src/project/cli.js', import.meta.url).href;

async function inFreshProcess(operation: string) {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ load(url, context, next) {
      if (/\\/executors\\/pi\\.js$/.test(url) || /\\/node_modules\\/(?:@earendil-works\\/pi-|@anthropic-ai\\/sdk\\/|openai\\/|@google\\/genai\\/)/.test(url)) loaded.push(url);
      return next(url, context);
    } });
    ${operation}
    process.stdout.write(JSON.stringify({ loaded }));
  `;
  const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', source], {
    timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')),
  });
  return JSON.parse(stdout) as { loaded: string[] };
}

test('Human and Runtime readiness do not load the Agent or Provider runtime in fresh processes', async t => {
  for (const profile of [{ kind: 'human' }, { kind: 'runtime', command: 'node', args: ['--test', 'fixture.test.mjs'] }]) {
    await t.test(profile.kind, async () => {
      const observed = await inFreshProcess(`
        const { createExecutorRegistry } = await import(${JSON.stringify(registryUrl)});
        const registry = createExecutorRegistry({ alarmMethods: [async () => { throw new Error('Readiness must not notify.'); }] });
        assert.equal((await registry.canExecute({ profile: ${JSON.stringify(profile)} })).ok, true);
      `);
      assert.deepEqual(observed.loaded, []);
    });
  }
});

test('project CLI help avoids importing the Agent and Provider runtime', async () => {
  const observed = await inFreshProcess(`
    const { main } = await import(${JSON.stringify(cliUrl)});
    let output = '';
    const sink = { write(value) { output += value; } };
    assert.equal(await main(['--help'], { stdout: sink, stderr: sink }), 0);
    assert.match(output, /ccdd-project/);
  `);
  assert.deepEqual(observed.loaded, []);
});

test('Agent readiness loads the real runtime and retains catalog and authentication option validation', async () => {
  const observed = await inFreshProcess(`
    const { createExecutorRegistry } = await import(${JSON.stringify(registryUrl)});
    const profile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' };
    assert.equal((await createExecutorRegistry().canExecute({ profile })).ok, true);
    const invalid = await createExecutorRegistry().canExecute({ profile: { ...profile, provider: 'unregistered-fixture-provider' } });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'PROVIDER_NOT_REGISTERED');
    const auth = await createExecutorRegistry({ piOptions: { authFile: 'relative-auth.json' } }).canExecute({ profile });
    assert.equal(auth.ok, false);
    assert.equal(auth.code, 'AUTHENTICATION_PATH_INVALID');
  `);
  assert.ok(observed.loaded.some(url => url.endsWith('/executors/pi.js')));
  assert.ok(observed.loaded.some(url => url.includes('/node_modules/@earendil-works/pi-ai/')));
});
