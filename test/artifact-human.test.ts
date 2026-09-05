import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHumanArtifactTools } from '../src/artifacts/human.js';
import { validateArtifactType } from '../src/artifacts/types.js';

async function fixture(t: TestContext, script = "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],JSON.stringify({path:process.argv[3],cwd:process.cwd(),key:process.env.CCDD_TEST_PROVIDER_SECRET??null}));") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ccdd-human-tool-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktreePath = join(dir, 'input');
  await mkdir(join(worktreePath, 'docs'), { recursive: true });
  await writeFile(join(worktreePath, 'docs', 'note $(no-shell).md'), 'A human may inspect this.\n');
  await writeFile(join(worktreePath, 'secret.md'), 'An undeclared Artifact.');
  const program = join(dir, 'registered.mjs');
  const output = join(dir, 'program-output.json');
  await writeFile(program, script);
  const artifacts = [{ id: 'docs', type: 'documents', path: 'docs' }];
  const command = { description: 'Open {artifactName} in a local viewer.', command: process.execPath, args: [program, output, '{artifactPath}'] };
  const artifactTypes = { documents: { viewer: 'files' as const, agentTools: {}, humanTools: { read: {}, list: {}, open: command } } };
  return { dir, worktreePath, artifacts, artifactTypes, output, program };
}

test('Human registry lists/preflights without launching and executes only fixed argv with a scoped snapshot target', async t => {
  const data = await fixture(t);
  const registry = await createHumanArtifactTools(data);
  assert.deepEqual(registry.tools.map(tool => tool.name), ['list_docs', 'read_docs', 'open_docs']);
  const command = registry.tools.find(tool => tool.name === 'open_docs')!;
  assert.equal(command.description, 'Open docs in a local viewer.');
  assert.equal(JSON.stringify(registry.tools).includes(data.program), false, 'The public definitions do not disclose program argv.');
  assert.ok((await registry.preflight()).every(check => check.ok));
  await assert.rejects(readFile(data.output), { code: 'ENOENT' });
  const listing = await registry.call('list_docs');
  assert.ok('entries' in listing);
  const read = await registry.call('read_docs', { path: 'note $(no-shell).md' });
  assert.ok('content' in read && read.content.includes('human'));
  process.env.CCDD_TEST_PROVIDER_SECRET = 'must-not-inherit';
  t.after(() => { delete process.env.CCDD_TEST_PROVIDER_SECRET; });
  const result = await registry.call('open_docs', { path: 'note $(no-shell).md' });
  assert.deepEqual(JSON.parse(await readFile(data.output, 'utf8')), { path: join(data.worktreePath, 'docs', 'note $(no-shell).md'), cwd: join(data.worktreePath, 'docs'), key: null });
  assert.ok('kind' in result && result.kind === 'launch' && result.launched);
  assert.equal('verdict' in result || 'observation' in result || 'toolCalls' in registry, false);
  assert.match(result.message, /does not confirm/);
});

test('Human tool calls reject arbitrary browser commands, undeclared paths, traversal and symlinks', async t => {
  const data = await fixture(t);
  await symlink('../secret.md', join(data.worktreePath, 'docs', 'alias.md'));
  const registry = await createHumanArtifactTools(data);
  for (const args of [{ command: process.execPath }, { args: [] }, { path: '../secret.md' }, { path: data.output }, { path: 'alias.md' }, { path: null }, { path: 12 }]) await assert.rejects(registry.call('open_docs', args));
  await assert.rejects(registry.call('open_secret'));
  await assert.rejects(registry.call('open_docs', null));
  await assert.rejects(readFile(data.output), { code: 'ENOENT' });
  const file = await createHumanArtifactTools({ ...data, artifacts: [{ id: 'file', type: 'documents', path: 'secret.md' }] });
  await assert.rejects(file.call('open_file', { path: '' }));
});

test('Human definitions freeze configured commands and input validation against later caller mutation', async t => {
  const data = await fixture(t);
  const registry = await createHumanArtifactTools(data);
  data.artifactTypes.documents.humanTools.open.command = 'unavailable-command-after-registration';
  registry.tools.find(tool => tool.name === 'open_docs')!.inputSchema.properties.command = { type: 'string' };
  await assert.rejects(registry.call('open_docs', { command: 'untrusted' }));
  await registry.call('open_docs');
  assert.equal(JSON.parse(await readFile(data.output, 'utf8')).path, join(data.worktreePath, 'docs'));
});

test('Human command readiness and failures do not expose raw output or create completion evidence', async t => {
  const data = await fixture(t, "process.stdout.write('secret-output'); process.stderr.write('secret-error'); process.exit(3);");
  const registry = await createHumanArtifactTools(data);
  await assert.rejects(registry.call('open_docs'), error => error instanceof Error && /did not finish/.test(error.message) && !/secret/.test(error.message));
  data.artifactTypes.documents.humanTools.open.command = '/ccdd-nonexistent-program';
  const missing = await createHumanArtifactTools(data);
  assert.equal((await missing.preflight({ toolName: 'open_docs' }))[0].ok, false);
  await assert.rejects(missing.call('open_docs'), /executable is unavailable/);
  await assert.rejects(missing.preflight({ toolName: 'anything' }), /Unknown/);
});

test('Human commands have bounded timeouts and cancellation even when the process ignores SIGTERM', async t => {
  const data = await fixture(t, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  const timed = await createHumanArtifactTools({ ...data, artifactTypes: { documents: { ...data.artifactTypes.documents, humanTools: { open: { ...data.artifactTypes.documents.humanTools.open, timeoutMs: 60 } } } } });
  let started = Date.now();
  await assert.rejects(timed.call('open_docs'), /exceeded 60 ms/);
  assert.ok(Date.now() - started < 2_000);
  const controller = new AbortController();
  const cancelled = await createHumanArtifactTools({ ...data, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    started = Date.now();
    await assert.rejects(cancelled.call('open_docs'), /cancelled/);
    assert.ok(Date.now() - started < 2_000);
  } finally { clearTimeout(timer); }
});

test('Human timeout kills SIGTERM-ignoring descendants even when their launcher exits first', async t => {
  const childCode = "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);";
  const data = await fixture(t, `import {spawn} from 'node:child_process'; spawn(process.execPath,['-e',${JSON.stringify(childCode)},process.argv[2]],{stdio:'ignore'}); setInterval(()=>{},1000);`);
  const registry = await createHumanArtifactTools({ ...data, artifactTypes: { documents: { ...data.artifactTypes.documents, humanTools: { open: { ...data.artifactTypes.documents.humanTools.open, timeoutMs: 500 } } } } });
  const completion = registry.call('open_docs').then(() => undefined, error => error as unknown);
  let descendant = 0;
  for (let attempt = 0; attempt < 100 && !descendant; attempt++) {
    descendant = Number(await readFile(data.output, 'utf8').catch(() => '0'));
    if (!descendant) await delay(5);
  }
  assert.ok(Number.isSafeInteger(descendant) && descendant > 1, 'The descendant installed its SIGTERM handler before the timeout.');
  const alive = (): boolean => { try { process.kill(descendant, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  t.after(() => { if (alive()) process.kill(descendant, 'SIGKILL'); });
  const error = await completion;
  assert.ok(error instanceof Error && /exceeded 500 ms/.test(error.message));
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(5);
  assert.equal(alive(), false, 'Remaining process-group descendants must not survive the launcher close event.');
});

test('Human-only binary artifacts need no builtin text read for readiness; empty maps stay unavailable', async t => {
  const data = await fixture(t);
  await writeFile(join(data.worktreePath, 'image.bin'), Buffer.from([0, 255, 1, 2]));
  const registry = await createHumanArtifactTools({ ...data, artifacts: [{ id: 'image', type: 'documents', path: 'image.bin' }], artifactTypes: { documents: { viewer: 'files', humanTools: { open: data.artifactTypes.documents.humanTools.open } } } });
  assert.deepEqual(registry.tools.map(tool => tool.name), ['open_image']);
  assert.equal((await registry.preflight())[0].ok, true);
  const empty = await createHumanArtifactTools({ ...data, artifactTypes: { documents: { viewer: 'files', agentTools: { read: {}, list: {} } } } });
  assert.deepEqual(empty.tools, []);
  const historic = await createHumanArtifactTools({ ...data, artifactTypes: { documents: { viewer: 'files' } } });
  assert.deepEqual(historic.tools, []);
});

test('type validation restricts templates and registrations; ambiguous published tool names fail', async t => {
  const data = await fixture(t);
  const command = data.artifactTypes.documents.humanTools.open;
  for (const definition of [
    { viewer: 'text', agentTools: { list: {} } }, { viewer: 'text', agentTools: { shell: {} } },
    { viewer: 'text', humanTools: { open: { ...command, args: ['prefix{artifactPath}'] } } },
    { viewer: 'text', humanTools: { open: { ...command, command: './script' } } },
    { viewer: 'text', humanTools: { open: { ...command, args: ['no-artifact'] } } },
    { viewer: 'text', humanTools: { open: { ...command, timeoutMs: 120_001 } } },
    { viewer: 'text', humanTools: { read: { command: 'open' } } },
    { viewer: 'text', agentTools: null }, { viewer: 'text', humanTools: [] },
  ]) assert.throws(() => validateArtifactType('type', definition));
  await assert.rejects(createHumanArtifactTools({ ...data, artifacts: [{ id: 'x_y', type: 'first', path: 'secret.md' }, { id: 'y', type: 'second', path: 'secret.md' }], artifactTypes: { first: { viewer: 'text', humanTools: { open: command } }, second: { viewer: 'text', humanTools: { open_x: command } } } }), /collide/);
});
