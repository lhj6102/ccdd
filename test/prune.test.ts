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
