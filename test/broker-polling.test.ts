import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createStatusPolling } from '../src/broker/polling.js';

test('scheduler ticks read status rows instead of consumer-sized run and request JSON', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,data TEXT); CREATE TABLE requests(id TEXT PRIMARY KEY,run_id TEXT,ordinal INTEGER,status TEXT,data TEXT);');
  const polling = createStatusPolling(db);
  const large = JSON.stringify({ scope: 'x'.repeat(543_000) });
  db.prepare('INSERT INTO runs VALUES (?,?,?)').run('run', 'RUNNING', large);
  db.prepare('INSERT INTO requests VALUES (?,?,?,?,?)').run('request', 'run', 0, 'RUNNING', large);
  let fullBytes = 0, statusBytes = 0;
  for (let tick = 0; tick < 20; tick++) {
    fullBytes += Buffer.byteLength(JSON.stringify([db.prepare('SELECT data FROM runs WHERE id = ?').get('run'), db.prepare('SELECT data FROM requests WHERE run_id = ?').all('run')]));
    statusBytes += Buffer.byteLength(JSON.stringify([polling.runStatus('run'), polling.requests('run'), polling.revision()]));
  }
  assert.ok(statusBytes < fullBytes / 1000);
  t.diagnostic(`20 scheduler ticks: hydrated bytes before=${fullBytes}, after=${statusBytes}; per tick before=${fullBytes / 20}, after=${statusBytes / 20}`);
  const revision = polling.revision();
  db.prepare('UPDATE requests SET data = ? WHERE id = ?').run('updated telemetry/claim metadata', 'request');
  assert.equal(polling.revision(), revision, 'non-status updates do not trigger replanning');
  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run('GREEN', 'request');
  assert.equal(polling.revision(), revision + 1);
  assert.deepEqual(polling.requests('run').map(row => ({ ...row })), [{ id: 'request', status: 'GREEN' }]);
  db.prepare('DELETE FROM requests WHERE id = ?').run('request');
  assert.equal(polling.revision(), revision + 2);
});

test('a waiting run observes another process terminal request transition through the shared revision', async t => {
  const { artifactFixture } = await import('./helpers/artifacts.js');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const data = await artifactFixture(t), filename = join(data.root, 'polling.sqlite');
  const db = new DatabaseSync(filename); t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE runs(id TEXT PRIMARY KEY,status TEXT,data TEXT); CREATE TABLE requests(id TEXT PRIMARY KEY,run_id TEXT,ordinal INTEGER,status TEXT,data TEXT);");
  const polling = createStatusPolling(db);
  db.prepare('INSERT INTO runs VALUES (?,?,?)').run('run-A', 'RUNNING', 'large-record-not-needed');
  db.prepare('INSERT INTO runs VALUES (?,?,?)').run('run-B', 'BLOCKED', 'large-record-not-needed');
  db.prepare('INSERT INTO requests VALUES (?,?,?,?,?)').run('request-A', 'run-A', 0, 'RUNNING', 'large-record-not-needed');
  // Run B's process waits only on the revision. The query/reuse policy is not
  // reproduced here: it belongs to Project Validation, not status polling.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
    import { createStatusPolling } from ${JSON.stringify(new URL('../src/broker/polling.js', import.meta.url).href)};
    const db = new DatabaseSync(process.argv[1]);
    const polling = createStatusPolling(db), revision = polling.revision();
    process.send({ ready: true, revision });
    const timer = setInterval(() => {
      if (polling.revision() === revision) return;
      clearInterval(timer);
      process.send({ woke: true, requests: polling.requests('run-A'), revision: polling.revision() });
      db.close(); process.disconnect();
    }, 10);
  `, filename], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill());
  const ready = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  assert.equal(ready[0].ready, true);
  const message = once(child, 'message', { signal: AbortSignal.timeout(5000) }), exited = once(child, 'exit');
  const revision = polling.revision();
  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run('GREEN', 'request-A');
  const [woke] = await message;
  assert.equal(woke.woke, true); assert.equal(woke.revision, revision + 1);
  assert.deepEqual(woke.requests, [{ id: 'request-A', status: 'GREEN' }]);
  assert.equal((await exited)[0], 0);
});

test('real idle broker ticks neither hydrate records nor replan and a remote Human completion advances the run', { timeout: 15000 }, async t => {
  const { artifactFixture, fixtureViews } = await import('./helpers/artifacts.js');
  const { createBroker, brokerTestHooks } = await import('../src/broker/index.js');
  const { createExecutorRegistry } = await import('../src/executors/index.js');
  const { spawn } = await import('node:child_process');
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', views: fixtureViews(), critics: [{ id: 'human', title: 'Review', profile: { kind: 'human' }, payload: { instruction: 'Read {a}.' } }] });
  const broker = createBroker({ ...data, executors: createExecutorRegistry({ alarmMethods: [async () => {}] }) }); data.cleanup(() => broker.close());
  const submitted = await broker.submitProject({ selection: { kind: 'all' } });
  let bytes = 0, plans = 0, ticks = 0, previous: { bytes: number; plans: number } | undefined;
  const samples: { bytes: number; plans: number }[] = [];
  let ready!: () => void; const idle = new Promise<void>(resolve => { ready = resolve; });
  brokerTestHooks.onHydrate = count => { bytes += count; };
  brokerTestHooks.onPlan = () => { plans++; };
  brokerTestHooks.onIdleTick = () => {
    if (previous) samples.push({ bytes: bytes - previous.bytes, plans: plans - previous.plans });
    previous = { bytes, plans }; if (++ticks === 4) ready();
  };
  t.after(() => { delete brokerTestHooks.onHydrate; delete brokerTestHooks.onPlan; delete brokerTestHooks.onIdleTick; });
  const running = broker.run(submitted.id);
  await Promise.race([idle, new Promise((_, reject) => setTimeout(() => reject(new Error('Scheduler did not idle')), 5000).unref())]);
  assert.deepEqual(samples.slice(0, 3), Array.from({ length: 3 }, () => ({ bytes: 0, plans: 0 })));
  t.diagnostic('Real broker: 3 unchanged idle ticks, 0 hydrated JSON bytes and 0 planner calls per tick (ownership polling included).');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createBroker } from ${JSON.stringify(new URL('../src/broker/index.js', import.meta.url).href)};
    const broker = createBroker({ repoPath: process.argv[1], stateDir: process.argv[2] });
    await broker.claimHuman(process.argv[3], 'remote-reviewer');
    await broker.completeHuman(process.argv[3], { reviewerId: 'remote-reviewer', result: { verdict: 'GREEN', summary: 'Controlled Human fixture', evidence: ['Controlled transport; no provider evaluation.'] } });
    await broker.close();
  `, data.repoPath, data.stateDir, submitted.requests[0].id], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill()); let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
  assert.equal((await once(child, 'exit'))[0], 0, stderr);
  assert.equal((await running)!.status, 'GREEN');
});
