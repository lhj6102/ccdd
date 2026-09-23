import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactFixture, fixtureViews, runtimeCritic, agentProfile } from './helpers/artifacts.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { diagnoseProject } from '../src/doctor/index.js';
import { artifactStream } from './pi-fixture.js';

async function fixture(t: Parameters<typeof artifactFixture>[0]) {
  const data = await artifactFixture(t);
  await data.write('spec', { name: 'spec', views: fixtureViews(), critics: [{ id: 'review', title: 'Review', profile: agentProfile, payload: { instruction: 'Read {spec}.' } }] });
  return data;
}

test('Agent readiness uses the real Pi loop with a private diagnostic nonce and no project script execution', async t => {
  const data = await fixture(t), marker = join(data.root, 'project-script');
  await writeFile(join(data.repoPath, 'spec/view.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');`);
  let calls = 0;
  const report = await diagnoseProject({ ...data, executors: createExecutorRegistry({ streamFn: artifactStream({ onRequest: ({ model, options }) => { calls++; assert.equal(model.id, 'gpt-6-astra'); assert.equal(options?.reasoning, 'medium'); } }) }) });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.ok(calls >= 2);
  assert.equal(report.checks.find(c => c.kind === 'agent')?.details?.operation, 'provider-artifact-roundtrip');
  await assert.rejects(readFile(marker), { code: 'ENOENT' }); await assert.rejects(readFile(join(data.stateDir, 'broker.sqlite')), { code: 'ENOENT' });
});

test('wrong nonce, Provider failures and missing observations cannot report readiness', async t => {
  for (const mode of ['wrong-nonce', 'no-tools', 'auth-error', 'model-error', 'network-error'] as const) {
    const data = await fixture(t), report = await diagnoseProject({ ...data, executors: createExecutorRegistry({ streamFn: artifactStream({ mode }) }) });
    assert.equal(report.ok, false); assert.doesNotMatch(JSON.stringify(report), /SECRET_TOKEN|PRIVATE_REASONING/);
  }
});

test('Runtime readiness starts Node and checks paths without running project tests', async t => {
  const data = await artifactFixture(t), marker = join(data.root, 'executed');
  await data.write('a', { name: 'a', critics: [runtimeCritic()] }, { 'check.test.mjs': `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');` });
  const report = await diagnoseProject({ ...data, executors: createExecutorRegistry() });
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.checks.find(c => c.kind === 'runtime')?.details?.testsExecuted, false);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Human readiness checks registration without alarms or view scripts', async t => {
  const data = await fixture(t); await data.edit('spec', m => { m.critics![0].profile = { kind: 'human' }; }); let notifications = 0;
  const report = await diagnoseProject({ ...data, executors: createExecutorRegistry({ alarmMethods: [async () => { notifications++; }] }) });
  assert.equal(report.ok, true); assert.equal(notifications, 0);
});

test('diagnostics reject changed inputs and malformed JSON without recording review results', async t => {
  const data = await fixture(t);
  const report = await diagnoseProject({ ...data, executors: { async probe() { await writeFile(join(data.repoPath, 'spec/content.txt'), 'changed'); return { ok: true, message: 'Controlled probe fixture', details: {} }; } } });
  assert.equal(report.ok, false); assert.ok(report.checks.some(c => c.details?.code === 'WORKSPACE_CHANGED'));
  await writeFile(join(data.repoPath, 'spec/ccdd.json'), 'invalid');
  assert.equal((await diagnoseProject({ ...data, executors: createExecutorRegistry() })).ok, false);
});
