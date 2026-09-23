import { runUntilSettled } from './helpers/run.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { activeTryClaim } from '../src/broker/human-claims.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import { startMonitor } from '../src/monitor/server.js';
import type { MonitorDetail } from '../src/monitor/types.js';


async function fixture(t: TestContext, script = 'console.log("Required runtime is available.");') {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-local-review-'));
  const repoPath = join(dir, 'project'), stateDir = join(dir, 'publisher');
  await mkdir(join(repoPath, 'checks'), { recursive: true });
  await writeFile(join(repoPath, 'checks', 'environment.mjs'), script);
  await writeFile(join(repoPath, 'asset.txt'), 'first asset');
  await writeFile(join(repoPath, 'unchanged-runtime.bin'), Buffer.alloc(256 * 1024, 7));
  const configMarker = join(dir, 'config-imports');
  await writeFile(configMarker, 'Static JSON discovery does not execute imports.');
  await writeFile(join(repoPath, 'ccdd.json'), JSON.stringify({ name: 'asset',
    envRequirements: { runtime: { description: 'Install the required runtime and retry.', script: 'checks/environment.mjs', timeoutMs: 10000 } },
    views: { humanTools: { view: { metadata: { description: 'Inspect {artifactName}.', inputSchema: { type: 'object', additionalProperties: false }, resultKinds: ['text'], observation: 'none' }, script: { command: 'node', args: ['view.mjs'] } } } },
    critics: [{ id: 'human', title: 'Inspect the asset', profile: { kind: 'human' }, payload: { instruction: 'Inspect {asset}.', privateField: 'NOT_IN_PORTABLE_REVIEW' } }],
  }));
  await writeFile(join(repoPath, 'view.mjs'), `import {readFile,writeFile} from 'node:fs/promises';let input='';for await(const chunk of process.stdin)input+=chunk;const {context}=JSON.parse(input);const text=await readFile(context.artifactPath+'/asset.txt','utf8');await writeFile(context.outputDir+'/actually-viewed.txt',text);process.stdout.write(JSON.stringify({content:[{type:'text',text}]}));`);
  const broker = createBroker({ repoPath, stateDir, repoId: 'test', executors: {
    canExecute: () => ({ ok: true }), notifyHuman: async () => {},
    execute: async () => { throw new Error('This fixture must perform only actual Human tool execution.'); },
  } });
  const submit = async () => {
    const run = await broker.submitProject({ selection: { kind: 'all' }, requesterId: 'test-builder', force: true });
    await runUntilSettled(broker, run.id);
    return broker.getRequest(run.requests[0].id)!;
  };
  const request = await submit();
  t.after(async () => { await broker.close(); await removeOwnedWorkspaceTree(dir); });
  return { dir, repoPath, stateDir, broker, request, submit, configMarker };
}

test('local Try Claim is exclusive and stale attempts cannot renew or release a newer reservation', async t => {
  const data = await fixture(t), id = data.request.id;
  const first = data.broker.tryClaimHuman(id, 'alice', { leaseMs: 20 });
  assert.throws(() => data.broker.tryClaimHuman(id, 'bob'), /another claim attempt/);
  await delay(50);
  const second = data.broker.tryClaimHuman(id, 'bob');
  assert.notEqual(second.id, first.id);
  assert.throws(() => data.broker.renewHumanTryClaim(id, 'alice', first.id), /expired|owned/);
  assert.equal(data.broker.releaseHumanTryClaim(id, 'alice', first.id), false);
  assert.equal(data.broker.getRequest(id)!.tryClaim!.id, second.id);
  assert.equal(data.broker.releaseHumanTryClaim(id, 'bob', second.id), true);
  const confirmed = await data.broker.claimHuman(id, 'bob');
  assert.equal(confirmed.claimedBy, 'bob');
  assert.equal(data.broker.releaseHumanTryClaim(id, 'alice', first.id), false);
  assert.equal(data.broker.getRequest(id)!.claimedBy, 'bob');
});

test('local monitor projects Try Claim without executing checks and returns preparation errors to its reviewer', async t => {
  const data = await fixture(t, 'console.error("Install the missing review runtime."); process.exit(5);');
  const monitor = await startMonitor({ stateDirs: [data.stateDir], stateHome: join(data.dir, 'empty-state-home'), port: 0 });
  t.after(() => monitor.close());
  const sessionResponse = await fetch(monitor.url + '/api/session');
  const session = await sessionResponse.json() as { reviewerId: string; csrfToken: string };
  const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
  const overview = await (await fetch(monitor.url + '/api/requests')).json() as { requests: { id: string; projectId: string }[] };
  const projectId = overview.requests.find(request => request.id === data.request.id)!.projectId;
  const route = `${monitor.url}/api/requests/${projectId}/${data.request.id}`;
  const attempt = data.broker.tryClaimHuman(data.request.id, session.reviewerId);
  const before = await readFile(data.configMarker, 'utf8');
  const detail = await (await fetch(route, { headers: { cookie } })).json() as MonitorDetail;
  assert.equal(detail.human!.canClaim, false); assert.equal(detail.human!.canComplete, false);
  assert.equal(detail.human!.tryClaim?.preparingByMe, true);
  const preparation = detail.human!.preparation;
  assert.equal(preparation?.id, attempt.id, 'The active preparation attempt must be identifiable while the Claim is pending.');
  assert.equal(preparation?.status, 'preparing');
  assert.equal(preparation?.phase, 'validating-input');
  assert.ok(preparation!.elapsedMs >= 0);
  assert.ok(Number.isFinite(Date.parse(preparation!.heartbeatAt)));
  assert.match(detail.request.waitingReason!, /Try Claim/);
  assert.equal(await readFile(data.configMarker, 'utf8'), before);
  data.broker.releaseHumanTryClaim(data.request.id, session.reviewerId, attempt.id);
  const failed = await fetch(route + '/claim', { method: 'POST', headers: { cookie, origin: monitor.url, 'x-ccdd-csrf': session.csrfToken, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(failed.status, 409);
  assert.match(await failed.text(), /Install the missing review runtime/);
  assert.equal(data.broker.getRequest(data.request.id)!.claimedBy, null);
  assert.equal(data.broker.getRequest(data.request.id)!.tryClaim, undefined);
  assert.equal(data.broker.getRequest(data.request.id)!.status, 'WAITING_HUMAN');
  const released = await (await fetch(route, { headers: { cookie } })).json() as MonitorDetail;
  assert.equal(released.human!.canClaim, true);
  assert.equal(released.human!.preparation!.status, 'released');
  assert.equal(released.human!.preparation!.failureCode, 'checks-failed');
  assert.match(released.human!.preparation!.nextAction!, /retry Claim/);
  assert.notEqual(released.human!.preparation!.id, attempt.id);
  assert.equal(released.human!.preparation!.previousAttemptId, attempt.id);
  assert.ok(released.human!.preparation!.timings.some(timing => timing.phase === 'checking-environment'));
  const expiring = data.broker.tryClaimHuman(data.request.id, session.reviewerId, { leaseMs: 20 });
  await delay(50);
  const storedBefore = await readFile(join(data.stateDir, 'broker.sqlite'));
  const importsBefore = await readFile(data.configMarker, 'utf8');
  const expired = await (await fetch(route, { headers: { cookie } })).json() as MonitorDetail;
  assert.equal(expired.human!.canClaim, true);
  assert.equal(expired.human!.tryClaim, undefined);
  assert.equal(expired.human!.preparation!.id, expiring.id);
  assert.equal(expired.human!.preparation!.status, 'expired');
  assert.equal(expired.human!.preparation!.completedAt, expiring.expiresAt);
  assert.equal(expired.human!.preparation!.previousAttemptId, released.human!.preparation!.id);
  assert.match(expired.human!.preparation!.nextAction!, /Retry Claim/);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), storedBefore);
  assert.equal(await readFile(data.configMarker, 'utf8'), importsBefore);
});

test('a pending local Claim exposes real phases, heartbeat, scanner counts and terminal timings through observational monitor reads', async t => {
  const control = await mkdtemp(join(tmpdir(), 'ccdd-preparation-progress-'));
  t.after(() => rm(control, { recursive: true, force: true }));
  const gate = join(control, 'continue');
  const environmentStarted = join(control, 'started');
  const data = await fixture(t, `import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(environmentStarted)}, 'started');
    while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));
    console.log('Environment is ready.');`);
  const monitor = await startMonitor({ stateDirs: [data.stateDir], stateHome: join(data.dir, 'empty-state-home'), port: 0 });
  t.after(() => monitor.close());
  const response = await fetch(monitor.url + '/api/session');
  const session = await response.json() as { reviewerId: string; csrfToken: string };
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const overview = await (await fetch(monitor.url + '/api/requests')).json() as { requests: { id: string; projectId: string }[] };
  const projectId = overview.requests.find(request => request.id === data.request.id)!.projectId;
  const route = `${monitor.url}/api/requests/${projectId}/${data.request.id}`;
  const pending = fetch(route + '/claim', { method: 'POST', headers: { cookie, origin: monitor.url, 'x-ccdd-csrf': session.csrfToken, 'content-type': 'application/json' }, body: '{}' });
  const read = async () => await (await fetch(route, { headers: { cookie } })).json() as MonitorDetail;
  const waitFor = async (matches: (detail: MonitorDetail) => boolean) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) { const detail = await read(); if (matches(detail)) return detail; await delay(25); }
    assert.fail('Expected real preparation progress before the environment check timed out.');
  };
  try {
    const preparing = await waitFor(detail => detail.human?.preparation?.phase === 'checking-environment');
    const attempt = preparing.human!.preparation!;
    assert.equal(attempt.status, 'preparing');
    assert.equal(attempt.preparingByMe, true);
    assert.equal(preparing.request.claimedBy, null);
    assert.equal(preparing.human!.tryClaim!.id, attempt.id);
    for (let i = 0; i < 200 && !await readFile(environmentStarted).then(() => true, () => false); i++) await delay(10);
    assert.equal(await readFile(environmentStarted, 'utf8'), 'started');
    const importsBefore = await readFile(data.configMarker, 'utf8');
    const heartbeat = await waitFor(detail => detail.human?.preparation?.heartbeatAt !== attempt.heartbeatAt);
    assert.equal(heartbeat.human!.preparation!.id, attempt.id);
    assert.equal(heartbeat.human!.preparation!.phase, 'checking-environment');
    assert.ok(heartbeat.human!.preparation!.elapsedMs >= attempt.elapsedMs);
    assert.ok(Date.parse(heartbeat.human!.preparation!.expiresAt) > Date.parse(attempt.expiresAt));
    assert.equal(await readFile(data.configMarker, 'utf8'), importsBefore);
    await writeFile(gate, 'continue');
    assert.equal((await pending).status, 200);
    const claimed = await read();
    const completed = claimed.human!.preparation!;
    assert.equal(completed.id, attempt.id);
    assert.equal(completed.status, 'claimed');
    assert.equal(claimed.human!.tryClaim, undefined);
    assert.equal(claimed.human!.claimedByMe, true);
    assert.equal(completed.completedAt, claimed.request.claimedAt);
    assert.deepEqual(completed.timings.map(timing => timing.phase), ['validating-input', 'checking-manifest', 'checking-environment', 'preflighting-tools', 'final-validation', 'confirming-assignment']);
    assert.ok(completed.timings.every(timing => timing.durationMs >= 0));
    assert.equal(completed.progress!.kind, 'content');
    assert.equal(completed.progress!.completed, true);
    assert.ok(completed.progress!.files >= 4);
    assert.ok(completed.progress!.bytes >= 256 * 1024);
    assert.equal(data.broker.getRequest(data.request.id)!.result, null);
  } finally { await writeFile(gate, 'continue'); await pending; }
});

test('both local CLI entrypoints cancel actual check processes and release Try Claim before exiting', async t => {
  if (process.platform === 'win32') return;
  const data = await fixture(t), marker = join(data.dir, 'checker-pid');
  await writeFile(join(data.repoPath, 'checks', 'environment.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); await new Promise(resolve => setTimeout(resolve, 9000));`);
  const request = await data.submit();
  for (const [entrypoint, action] of [['../src/project/cli.js', ['request', 'claim']], ['../src/cli.js', ['request', 'claim']]] as const) {
    await rm(marker, { force: true });
    const child = spawn(process.execPath, [fileURLToPath(new URL(entrypoint, import.meta.url)), ...action, request.id, '--state-dir', data.stateDir, '--reviewer', 'alice'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    let checkerPid = 0;
    try {
      const deadline = Date.now() + 10000;
      while (!checkerPid && Date.now() < deadline) {
        checkerPid = Number(await readFile(marker, 'utf8').catch(() => '0'));
        if (!checkerPid) await delay(20);
      }
      assert.ok(checkerPid, stderr);
      assert.ok(activeTryClaim(data.broker.getRequest(request.id)!));
      child.kill('SIGINT');
      const code = await Promise.race([exited, delay(5000).then(() => { throw new Error('Claim cancellation did not finish.'); })]);
      assert.equal(code, 2, stderr);
      assert.match(stderr, /Try Claim/); assert.match(stderr, /cancelled/);
      assert.throws(() => process.kill(checkerPid, 0), { code: 'ESRCH' });
      assert.equal(data.broker.getRequest(request.id)!.tryClaim, undefined);
      assert.equal(data.broker.getRequest(request.id)!.claimedBy, null);
      assert.equal(data.broker.getRequest(request.id)!.status, 'WAITING_HUMAN');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (checkerPid) try { process.kill(-checkerPid, 'SIGKILL'); } catch { /* The check was already cleaned up. */ }
      await exited;
    }
  }
});

