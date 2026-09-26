import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifactFixture, runtimeCritic } from './helpers/artifacts.js';
import { createBroker, createExecutorRegistry, pruneProject } from '../src/project/index.js';
import { main } from '../src/project/cli.js';

async function fixture(t: import('node:test').TestContext) {
  const data = await artifactFixture(t);
  await data.write('a', { name: 'a', critics: [runtimeCritic()] });
  const broker = createBroker({ ...data, executors: createExecutorRegistry() }); data.cleanup(() => broker.close());
  const run = await broker.submitProject({ selection: { kind: 'all' } });
  const request = run.requests[0], directory = join(data.stateDir, 'runs', run.id, request.id);
  return { ...data, broker, run, request, directory };
}
const audit = (stateDir: string) => {
  const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true });
  try { return JSON.stringify(['runs', 'requests', 'events', 'metadata', 'run_owners'].map(table => db.prepare(`SELECT * FROM ${table}`).all())); }
  finally { db.close(); }
};

test('explicit SDK and CLI prune remove only terminal request scratch while preserving all audit bytes', async t => {
  const data = await fixture(t);
  await data.broker.run(data.run.id);
  for (const name of ['output', 'tmp', 'cache', 'home', 'human-tools', 'preparation', 'tool-output-ABC123']) {
    await mkdir(join(data.directory, name), { recursive: true }); await writeFile(join(data.directory, name, 'transient'), 'discard');
  }
  for (const name of ['result.json', 'request.json', 'events.jsonl', 'tool-call-audit.jsonl', 'unknown']) await writeFile(join(data.directory, name), 'audit');
  const before = audit(data.stateDir);
  const result = pruneProject(data.stateDir);
  assert.equal(result.removed.length, 7);
  assert.equal(audit(data.stateDir), before);
  for (const name of ['result.json', 'request.json', 'events.jsonl', 'tool-call-audit.jsonl', 'unknown']) assert.equal(await readFile(join(data.directory, name), 'utf8'), 'audit');
  assert.deepEqual(pruneProject(data.stateDir).removed, []);
  await mkdir(join(data.directory, 'cache')); await writeFile(join(data.directory, 'cache', 'transient'), 'discard');
  let output = '';
  assert.equal(await main(['prune', '--state-dir', data.stateDir, '--json'], { stdout: { write: value => { output += value; } }, stderr: { write: value => { throw new Error(value); } } }), 0);
  assert.equal(JSON.parse(output).removed.length, 1);
  assert.equal(audit(data.stateDir), before);
});

test('prune leaves queued requests and terminal runs with owners untouched and never follows output symlinks', async t => {
  const data = await fixture(t);
  await mkdir(join(data.directory, 'cache'), { recursive: true }); await writeFile(join(data.directory, 'cache', 'live'), 'keep');
  assert.deepEqual(pruneProject(data.stateDir).skippedRequests, [data.request.id]);
  assert.equal(await readFile(join(data.directory, 'cache', 'live'), 'utf8'), 'keep');
  await data.broker.run(data.run.id);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite')); t.after(() => db.close());
  db.prepare('INSERT INTO run_owners VALUES (?,?,?,?,?)').run(data.run.id, process.pid, null, 'fixture-owner', new Date().toISOString());
  assert.deepEqual(pruneProject(data.stateDir).removed, []);
  db.prepare('DELETE FROM run_owners WHERE run_id = ?').run(data.run.id);
  const external = join(data.root, 'external'); await mkdir(external); await writeFile(join(external, 'evidence'), 'keep');
  await (await import('node:fs/promises')).rm(join(data.directory, 'tmp'), { recursive: true, force: true });
  await symlink(external, join(data.directory, 'tmp'));
  pruneProject(data.stateDir);
  assert.equal(await readFile(join(external, 'evidence'), 'utf8'), 'keep');
  await assert.rejects(stat(join(data.directory, 'tmp')), { code: 'ENOENT' });
});

test('prune does not traverse request-directory symlinks', async t => {
  const data = await fixture(t); await data.broker.run(data.run.id);
  const { rename } = await import('node:fs/promises');
  const external = join(data.root, 'saved-request'); await rename(data.directory, external);
  await mkdir(join(external, 'cache'), { recursive: true }); await writeFile(join(external, 'cache', 'evidence'), 'keep');
  await symlink(external, data.directory);
  assert.deepEqual(pruneProject(data.stateDir).removed, []);
  assert.equal(await readFile(join(external, 'cache', 'evidence'), 'utf8'), 'keep');
});

test('prune pins the request parent before a pathname is replaced by an external symlink', async t => {
  const data = await fixture(t); await data.broker.run(data.run.id);
  const fs = await import('node:fs');
  const { pruneTestHooks } = await import('../src/project/prune.js');
  const external = join(data.root, 'external'), displaced = join(data.root, 'displaced');
  await mkdir(join(external, 'cache'), { recursive: true }); await writeFile(join(external, 'cache', 'audit'), 'keep');
  let swapped = false;
  pruneTestHooks.beforeMove = () => {
    if (swapped) return; swapped = true;
    fs.renameSync(data.directory, displaced); fs.symlinkSync(external, data.directory);
  };
  t.after(() => { delete pruneTestHooks.beforeMove; });
  pruneProject(data.stateDir);
  assert.ok(swapped);
  assert.equal(await readFile(join(external, 'cache', 'audit'), 'utf8'), 'keep');
});

test('prune preserves a replaced scratch inode instead of recursively deleting it', async t => {
  const data = await fixture(t); await data.broker.run(data.run.id);
  const fs = await import('node:fs');
  const { pruneTestHooks } = await import('../src/project/prune.js');
  let replacement: string | undefined;
  pruneTestHooks.beforeMove = source => {
    if (replacement) return;
    fs.renameSync(source, source + '-original'); fs.mkdirSync(source); fs.writeFileSync(join(source, 'audit'), 'keep'); replacement = source;
  };
  t.after(() => { delete pruneTestHooks.beforeMove; });
  assert.throws(() => pruneProject(data.stateDir), /Scratch entry changed/);
  const quarantine = fs.readdirSync(data.stateDir).find(name => name.startsWith('.prune-'))!;
  assert.equal(await readFile(join(data.stateDir, quarantine, '0', 'audit'), 'utf8'), 'keep');
});

test('a real broker persists success while a separate prune process pauses deletion for 6.5 seconds', { timeout: 15000 }, async t => {
  const data = await fixture(t); await data.broker.run(data.run.id);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { pruneProject, pruneTestHooks } from ${JSON.stringify(new URL('../src/project/prune.js', import.meta.url).href)};
    pruneTestHooks.beforeDelete = () => {
      process.send({ deleting: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
    };
    pruneProject(process.argv[1]); process.disconnect();
  `, data.stateDir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill());
  const exited = once(child, 'exit');
  await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  const started = performance.now();
  const run = await data.broker.submitProject({ selection: { kind: 'all' }, force: true });
  const result = await data.broker.run(run.id);
  assert.equal(result!.status, 'GREEN');
  assert.ok(performance.now() - started < 4000, 'completion must not wait for deletion or hit the 5-second SQLite timeout');
  assert.equal((await exited)[0], 0);
});

test('final quarantine removal failure closes every descriptor and retains the recovery claim', async t => {
  const data = await fixture(t); await data.broker.run(data.run.id);
  await data.broker.close();
  const { readdirSync } = await import('node:fs');
  const { pruneTestHooks } = await import('../src/project/prune.js');
  const failure = Object.assign(new Error('Injected final removal failure'), { code: 'EACCES' });
  const before = readdirSync('/proc/self/fd').length;
  pruneTestHooks.removeQuarantine = () => { throw failure; };
  t.after(() => { delete pruneTestHooks.removeQuarantine; });
  assert.throws(() => pruneProject(data.stateDir), error => error === failure);
  assert.equal(readdirSync('/proc/self/fd').length, before);
  const quarantine = readdirSync(data.stateDir).find(name => name.startsWith('.prune-'))!;
  assert.ok(quarantine);
  const db = new DatabaseSync(join(data.stateDir, 'broker.sqlite'));
  try { assert.equal(db.prepare('SELECT id FROM prune_claims WHERE id = ?').get(quarantine)?.id, quarantine); }
  finally { db.close(); }
});

for (const originalFailure of [false, true]) test(`database close failure still closes root fd and preserves the first error (original=${originalFailure})`, async t => {
  const data = await fixture(t); await data.broker.run(data.run.id);
  await data.broker.close();
  const { readdirSync } = await import('node:fs');
  const { pruneTestHooks } = await import('../src/project/prune.js');
  const first = new Error('Original deletion error'), closing = new Error('Injected close error');
  const close = DatabaseSync.prototype.close;
  let closes = 0;
  const mock = t.mock.method(DatabaseSync.prototype, 'close', function(this: DatabaseSync) {
    close.call(this);
    // readStateContext closes its readonly connection first.
    if (++closes === 2) throw closing;
  });
  if (originalFailure) pruneTestHooks.beforeDelete = () => { throw first; };
  t.after(() => { delete pruneTestHooks.beforeDelete; mock.mock.restore(); });
  const before = readdirSync('/proc/self/fd').length;
  assert.throws(() => pruneProject(data.stateDir), error => error === (originalFailure ? first : closing));
  assert.equal(closes, 2);
  assert.equal(readdirSync('/proc/self/fd').length, before);
});
