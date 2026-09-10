import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from '../src/broker/index.js';
import { activeTryClaim } from '../src/broker/human-claims.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import { startReviewServer } from '../src/review/server.js';
import { claimRemoteReview, executeRemoteHumanTool, listRemoteReviews, submitRemoteHumanReview } from '../src/review/client.js';
import { reviewMain } from '../src/review/cli.js';
import { startMonitor } from '../src/monitor/server.js';
import { prepareHumanReview } from '../src/executors/human-preparation.js';
import type { RemoteReviewOptions } from '../src/review/client.js';

const aliceToken = 'a'.repeat(48), bobToken = 'b'.repeat(48);

async function fixture(t: TestContext, script = 'console.log("Required runtime is available.");') {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-remote-review-'));
  const repoPath = join(dir, 'project'), stateDir = join(dir, 'publisher'), cache = join(dir, 'reviewer');
  await mkdir(join(repoPath, 'checks'), { recursive: true });
  await writeFile(join(repoPath, 'checks', 'environment.mjs'), script);
  await writeFile(join(repoPath, 'asset.txt'), 'first asset');
  await writeFile(join(repoPath, 'unchanged-runtime.bin'), Buffer.alloc(256 * 1024, 7));
  const configMarker = join(dir, 'config-imports');
  await writeFile(join(repoPath, 'ccdd.config.ts'), `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    appendFileSync(${JSON.stringify(configMarker)}, 'imported\\n');
    export default {
      artifacts: { asset: { type: 'text', path: 'asset.txt' } },
      envRequirements: { runtime: { description: 'Install the required runtime and retry.', script: 'checks/environment.mjs', timeoutMs: 10000 } },
      artifactTypes: { text: { humanTools: { view: {
        metadata: { description: 'Inspect {artifactName}.', inputSchema: { type: 'object', additionalProperties: false }, resultKinds: ['text'], observation: 'none' },
        execute(context) {
          const text = readFileSync(context.artifactPath, 'utf8');
          writeFileSync(join(context.outputDir, 'actually-viewed.txt'), text);
          return { content: [{ type: 'text', text }] };
        }
      } } } },
      critics: [{ id: 'human', title: 'Inspect the asset', target: 'asset', deps: [], profile: { kind: 'human' }, payload: { instruction: 'Inspect {asset}.', privateField: 'NOT_IN_PORTABLE_REVIEW' } }]
    };`);
  const broker = createBroker({ repoPath, stateDir, repoId: 'test', executors: {
    canExecute: () => ({ ok: true }), notifyHuman: async () => {},
    execute: async () => { throw new Error('This fixture must perform only actual Human tool execution.'); },
  } });
  const submit = async () => {
    const run = await broker.submit({ requesterId: 'test-builder', mode: 'copy' });
    await broker.run(run.id);
    return broker.getRequest(run.requests[0].id)!;
  };
  const request = await submit();
  const server = await startReviewServer({ stateDir, reviewers: { alice: aliceToken, bob: bobToken }, port: 0 });
  t.after(async () => { await server.close(); await broker.close(); await removeOwnedWorkspaceTree(dir); });
  const alice: RemoteReviewOptions = { server: server.url, token: aliceToken, stateDir: cache };
  const bob: RemoteReviewOptions = { server: server.url, token: bobToken, stateDir: join(dir, 'bob') };
  const get = async (route: string, token = aliceToken) => fetch(server.url + route, { headers: { authorization: `Bearer ${token}` } });
  return { dir, repoPath, stateDir, cache, broker, request, server, alice, bob, get, submit, configMarker };
}

test('remote reviewer downloads the exact snapshot, runs a real local tool, submits centrally, and reuses unchanged file bytes', async t => {
  const data = await fixture(t);
  const phases: string[] = [];
  const first = await claimRemoteReview(data.request.id, { ...data.alice, onProgress: event => phases.push(event.phase) });
  assert.ok(first.downloadedBytes >= 256 * 1024);
  assert.equal(data.broker.getRequest(data.request.id)!.claimedBy, 'alice');
  assert.equal(data.broker.getRequest(data.request.id)!.tryClaim, undefined);
  assert.equal(first.snapshotHash, data.request.snapshotHash);
  assert.notEqual(first.workspacePath, data.request.workspace.path);
  assert.ok(phases.includes('download') && phases.includes('environment') && phases.includes('claimed'));
  await writeFile(join(data.repoPath, 'asset.txt'), 'second asset');
  const result = await executeRemoteHumanTool(data.request.id, 'view_asset', {}, data.alice) as { content: { text: string }[] };
  assert.equal(result.content[0].text, 'first asset');
  const outputs = join(data.cache, 'runs', data.request.runId, data.request.id, 'human-tools');
  assert.ok((await readdir(outputs)).length > 0);
  await assert.rejects(executeRemoteHumanTool(data.request.id, 'not_registered', {}, data.alice), /Unknown registered/);
  await assert.rejects(executeRemoteHumanTool(data.request.id, 'view_asset', { path: '../anything' }, data.alice), /argument|property|allowed/i);
  assert.equal(data.broker.getRequest(data.request.id)!.result, null);
  // This is a test reviewer submission, not Provider or release-verification evidence.
  await submitRemoteHumanReview(data.request.id, { verdict: 'GREEN', summary: 'Fixture reviewer inspected the first asset.', evidence: ['Actual local tool returned first asset.'] }, data.alice);
  assert.equal(data.broker.getRequest(data.request.id)!.status, 'GREEN');
  await assert.rejects(executeRemoteHumanTool(data.request.id, 'view_asset', {}, data.alice), /Claim/);
  const second = await data.submit();
  const next = await claimRemoteReview(second.id, data.alice);
  assert.equal(next.downloadedFiles, 1);
  assert.equal(next.downloadedBytes, Buffer.byteLength('second asset'));
  assert.ok(next.reusedFiles >= 3);
  assert.equal(await readFile(join(first.workspacePath, 'asset.txt'), 'utf8'), 'first asset');
  assert.equal(await readFile(join(next.workspacePath, 'asset.txt'), 'utf8'), 'second asset');
  const resumed = await claimRemoteReview(second.id, data.alice);
  assert.equal(resumed.downloadedBytes, 0);
});

test('environment failure releases Try Claim without failing the request and retains downloaded cache', async t => {
  const data = await fixture(t, 'console.error("Install Cargo and retry this claim."); process.exit(3);');
  await assert.rejects(claimRemoteReview(data.request.id, data.alice), /Install Cargo and retry/);
  const request = data.broker.getRequest(data.request.id)!;
  assert.equal(request.status, 'WAITING_HUMAN');
  assert.equal(request.claimedBy, null);
  assert.equal(request.tryClaim, undefined);
  assert.equal(request.result, null); assert.equal(request.error, null);
  assert.ok((await readdir(join(data.cache, 'workspace-blobs'))).length > 0);
  const attempt = data.broker.tryClaimHuman(request.id, 'bob');
  assert.equal(attempt.reviewerId, 'bob');
  assert.equal(data.broker.releaseHumanTryClaim(request.id, 'bob', attempt.id), true);
  await assert.rejects(data.broker.claimHuman(request.id, 'alice'), /Install Cargo and retry/);
  assert.equal(data.broker.getRequest(request.id)!.status, 'WAITING_HUMAN');
  assert.equal(data.broker.getRequest(request.id)!.claimedBy, null);
});

test('Try Claim is exclusive, expires without GET mutation, and stale attempts cannot confirm, renew or release a newer reservation', async t => {
  const data = await fixture(t);
  const first = data.broker.tryClaimHuman(data.request.id, 'alice', { leaseMs: 25 });
  assert.equal(data.broker.getRequest(data.request.id)!.claimedBy, null);
  assert.throws(() => data.broker.tryClaimHuman(data.request.id, 'bob'), /another claim attempt/);
  await assert.rejects(data.broker.executeHumanTool(data.request.id, { reviewerId: 'alice', toolName: 'view_asset' }), /reviewer who claimed/);
  await delay(40);
  const before = await readFile(join(data.stateDir, 'broker.sqlite'));
  const list = await listRemoteReviews(data.bob) as { preparation: unknown }[];
  assert.equal(list[0].preparation, null);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), before);
  assert.equal(data.broker.getRequest(data.request.id)!.tryClaim?.id, first.id);
  const second = data.broker.tryClaimHuman(data.request.id, 'bob');
  assert.equal(data.broker.releaseHumanTryClaim(data.request.id, 'alice', first.id), false);
  assert.throws(() => data.broker.renewHumanTryClaim(data.request.id, 'alice', first.id), /expired|owned/);
  assert.throws(() => data.broker.confirmHumanClaim(data.request.id, 'alice', first.id, { snapshotHash: data.request.snapshotHash, environment: [], tools: [] }), /expired|owned/);
  assert.throws(() => data.broker.confirmHumanClaim(data.request.id, 'bob', second.id, { snapshotHash: data.request.snapshotHash, configHash: data.request.configManifest!.configHash, environment: [], tools: [] }), /required preparation/);
  const prepared = await prepareHumanReview(data.request, data.request.workspace, join(data.dir, 'bob-preparation'));
  assert.equal(data.broker.confirmHumanClaim(data.request.id, 'bob', second.id, prepared).claimedBy, 'bob');
});

test('cancelling a claim during a real environment check releases its reservation', async t => {
  const data = await fixture(t, 'await new Promise(resolve => setTimeout(resolve, 9000));');
  const controller = new AbortController();
  const work = claimRemoteReview(data.request.id, { ...data.alice, signal: controller.signal, onProgress: event => {
    if (event.phase === 'environment') setTimeout(() => controller.abort(new Error('Test reviewer cancelled.')), 80);
  } });
  await assert.rejects(work, /cancelled|abort/i);
  assert.equal(data.broker.getRequest(data.request.id)!.tryClaim, undefined);
  assert.equal(data.broker.getRequest(data.request.id)!.claimedBy, null);
  assert.equal(data.broker.getRequest(data.request.id)!.status, 'WAITING_HUMAN');
});

test('server GETs use stored definitions without config/check execution or state changes and enforce reviewer access', async t => {
  const data = await fixture(t);
  const beforeConfig = await readFile(data.configMarker, 'utf8');
  const beforeDb = await readFile(join(data.stateDir, 'broker.sqlite'));
  assert.equal((await fetch(data.server.url + '/requests')).status, 401);
  assert.equal((await data.get('/requests', 'z'.repeat(48))).status, 401);
  assert.equal((await fetch(data.server.url + '/requests', { headers: { authorization: `Bearer ${aliceToken}`, origin: 'https://other.example' } })).status, 403);
  const detail = await (await data.get(`/requests/${data.request.id}`)).text();
  assert.doesNotMatch(detail, /NOT_IN_PORTABLE_REVIEW|sourcePath|worktreePath|stateDir/);
  assert.equal((await data.get(`/requests/${data.request.id}/snapshot`)).status, 403);
  await listRemoteReviews(data.alice);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), beforeDb);
  assert.equal(await readFile(data.configMarker, 'utf8'), beforeConfig);
  const attempt = data.broker.tryClaimHuman(data.request.id, 'alice');
  assert.equal((await data.get(`/requests/${data.request.id}/snapshot`, bobToken)).status, 403);
  const afterReservation = await readFile(join(data.stateDir, 'broker.sqlite'));
  assert.equal((await data.get(`/requests/${data.request.id}/snapshot`)).status, 200);
  assert.equal((await data.get(`/requests/${data.request.id}/blobs/${'0'.repeat(64)}`)).status, 409);
  assert.deepEqual(await readFile(join(data.stateDir, 'broker.sqlite')), afterReservation);
  assert.equal(await readFile(data.configMarker, 'utf8'), beforeConfig);
  data.broker.releaseHumanTryClaim(data.request.id, 'alice', attempt.id);
});

test('review CLI prepares and executes through the authenticated remote client', async t => {
  const data = await fixture(t);
  const tokenFile = join(data.dir, 'alice-token'); await writeFile(tokenFile, aliceToken, { mode: 0o600 });
  let output = '', error = '';
  const io = { stdout: { write: (value: string) => { output += value; } }, stderr: { write: (value: string) => { error += value; } } };
  const common = ['--server', data.server.url, '--token-file', tokenFile, '--cache-dir', data.cache, '--json'];
  assert.equal(await reviewMain(['claim', data.request.id, ...common], io), 0, error + output);
  assert.equal(JSON.parse(output).requestId, data.request.id);
  output = '';
  assert.equal(await reviewMain(['tool', data.request.id, '--tool', 'view_asset', ...common], io), 0, output);
  assert.equal(JSON.parse(output).content[0].text, 'first asset');
  assert.equal(activeTryClaim(data.broker.getRequest(data.request.id)!), undefined);
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
  const detail = await (await fetch(route, { headers: { cookie } })).json() as { human: { canClaim: boolean; canComplete: boolean; tryClaim?: { preparingByMe: boolean } }; request: { waitingReason: string } };
  assert.equal(detail.human.canClaim, false); assert.equal(detail.human.canComplete, false);
  assert.equal(detail.human.tryClaim?.preparingByMe, true);
  assert.match(detail.request.waitingReason, /Try Claim/);
  assert.equal(await readFile(data.configMarker, 'utf8'), before);
  data.broker.releaseHumanTryClaim(data.request.id, session.reviewerId, attempt.id);
  const failed = await fetch(route + '/claim', { method: 'POST', headers: { cookie, origin: monitor.url, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(failed.status, 409);
  assert.match(await failed.text(), /Install the missing review runtime/);
  assert.equal(data.broker.getRequest(data.request.id)!.claimedBy, null);
  assert.equal(data.broker.getRequest(data.request.id)!.tryClaim, undefined);
  assert.equal(data.broker.getRequest(data.request.id)!.status, 'WAITING_HUMAN');
});
