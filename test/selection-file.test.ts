import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/project/cli.js';
import { parseSelectionFile, readSelectionFile } from '../src/project/selection-file.js';

test('selection files support JSON, lines, BOM, CRLF and stable deduplication', () => {
  assert.deepEqual(parseSelectionFile('\uFEFF["a/review","b/review","a/review"]'), ['a/review', 'b/review']);
  assert.deepEqual(parseSelectionFile('\uFEFFa/review\r\n\r\nb/review\r\na/review\r\n'), ['a/review', 'b/review']);
  for (const value of ['', '[]', '["x",]', '[1]', '[" x"]', 'a,b', 'x\u0000']) assert.throws(() => parseSelectionFile(value));
  assert.throws(() => parseSelectionFile('x'.repeat(4 * 1024 ** 2 + 1)), /4 MiB/);
});

test('CLI file selectors use ordinary Critic and family validation and reject conflicting selectors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-selection-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await (await import('node:fs/promises')).mkdir(repo);
  await writeFile(join(repo, 'ccdd.json'), JSON.stringify({ name: 'fixture', critics: [{ id: 'review', title: 'Review', profile: { kind: 'human' }, payload: { instruction: 'Inspect {fixture}.' } }] }));
  const selection = join(root, 'critics.json'); await writeFile(selection, '["fixture/review"]');
  assert.deepEqual(await readSelectionFile(selection), ['fixture/review']);
  let out = '', err = ''; const io = { stdout: { write(v: string) { out += v; } }, stderr: { write(v: string) { err += v; } } };
  assert.equal(await main(['plan', '--repo', repo, '--state-dir', join(root, 'state'), '--critics-file', selection, '--json'], io), 0, err);
  assert.equal(JSON.parse(out).items[0].id, 'fixture/review');
  out = ''; err = '';
  assert.equal(await main(['plan', '--repo', repo, '--state-dir', join(root, 'state'), '--critics-file', selection, '--all'], io), 2);
  assert.match(err, /Choose one/);
});
