import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { artifactFixture, fixtureViews } from './helpers/artifacts.js';
import { createReviewTools, describeReviewTools } from '../src/tools/runner.js';
import { defineTool, type ToolMetadata } from '../src/sdk.js';
import { diagnoseArtifactTools } from '../src/artifacts/tool-check.js';
import { serveArtifactMcp } from '../src/artifacts/mcp-server.js';
import { PassThrough } from 'node:stream';
import { safeToolFailure } from '../src/tools/diagnostics.js';

const metadata: ToolMetadata = { description: 'Inspect {artifactName}.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text', 'json', 'image', 'launch'], observation: 'content' };
async function fixture(t: TestContext, script = "return {content:[{type:'text',text:'observed'}],observation:{kind:'content'}};", meta = metadata) {
  const data = await artifactFixture(t), views = fixtureViews();
  views.humanTools = { inspect: { metadata: meta, script: { command: 'node', args: ['inspect.mjs'] } } };
  await data.write('spec', { name: 'spec', views, critics: [{ id: 'review', title: 'Review', profile: { kind: 'human' }, payload: { instruction: 'Inspect {spec}.' } }] }, {
    'inspect.mjs': `import {readFile,writeFile,mkdir,symlink} from 'node:fs/promises';import {join} from 'node:path';import {spawn} from 'node:child_process';let text='';for await(const chunk of process.stdin)text+=chunk;const request=JSON.parse(text);const {context,args}=request;async function execute(){${script}}const result=await execute();process.stdout.write(JSON.stringify(result));`,
  });
  const request = (await data.requests())[0];
  const options = { ...request, worktreePath: data.repoPath, audience: 'human' as const, runDir: join(data.root, 'output') };
  return { ...data, options, request, registry: () => createReviewTools(options) };
}
const json = (value: Awaited<ReturnType<Awaited<ReturnType<typeof createReviewTools>>['call']>>) => { const block = value.content[0]; assert.ok(block.type === 'json'); return block.data; };

test('JSON discovery, stored descriptors and preflight never execute scripts; real calls receive protocol context', async t => {
  const data = await fixture(t, "await writeFile(join(context.outputDir,'receipt'), 'executed'); return {content:[{type:'json',data:{version:request.version,args,cwd:process.cwd(),context,secret:process.env.CCDD_TEST_SECRET??null,nodeOptions:process.env.NODE_OPTIONS??null}}]};");
  const before = await readFile(join(data.repoPath, 'spec/ccdd.json'), 'utf8');
  assert.equal(describeReviewTools(data.options)[0].name, 'inspect_spec');
  const registry = await data.registry(); t.after(() => registry.close());
  assert.ok((await registry.preflight()).every(check => check.ok));
  const old = process.env.CCDD_TEST_SECRET; process.env.CCDD_TEST_SECRET = 'not inherited';
  t.after(() => { if (old === undefined) delete process.env.CCDD_TEST_SECRET; else process.env.CCDD_TEST_SECRET = old; });
  const result = json(await registry.call('inspect_spec')) as any;
  assert.equal(result.version, 1); assert.equal(result.cwd, join(data.repoPath, 'spec'));
  assert.equal(result.context.scope.spec.path, result.cwd); assert.equal(result.context.artifactPath, result.cwd);
  assert.equal(result.secret, null); assert.equal(result.nodeOptions, null);
  assert.ok(result.context.outputDir.startsWith(data.root) && !result.context.outputDir.startsWith(data.repoPath));
  assert.equal(await readFile(join(data.repoPath, 'spec/ccdd.json'), 'utf8'), before);
});

test('fixed argv and schema validation prevent reviewer arguments from becoming command text', async t => {
  const meta = { ...metadata, inputSchema: { type: 'object', properties: { frame: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' } }, required: ['frame', 'enabled'], additionalProperties: false } };
  const data = await fixture(t, 'return {content:[{type:"json",data:args}]};', meta), registry = await data.registry(); t.after(() => registry.close());
  for (const args of [null, { frame: '1', enabled: true }, { frame: 1, enabled: 'false' }, { frame: 1, enabled: false, command: 'sh' }]) await assert.rejects(registry.call('inspect_spec', args), /arguments|schema/);
  assert.deepEqual(json(await registry.call('inspect_spec', { frame: 2, enabled: false })), { frame: 2, enabled: false });
  assert.equal(registry.toolCalls.length, 1);
  const calls = registry.toolCalls; calls.length = 0; assert.equal(registry.toolCalls.length, 1);
});

test('nested argument diagnostics identify paths and constraints without exposing values or trusting forged errors', async t => {
  const inputSchema = { type: 'object', properties: { tripods: { type: 'array', items: { type: 'object', properties: { level: { type: 'number' }, label: { enum: ['allowed'] }, fixed: { const: 'fixed' }, code: { type: 'string', pattern: '^safe$' } }, required: ['level'], additionalProperties: false } } }, additionalProperties: false };
  const data = await fixture(t, undefined, { ...metadata, inputSchema }), registry = await data.registry(); t.after(() => registry.close());
  const cases: Array<[unknown, RegExp[]]> = [
    [{ tripods: [{ level: 1, extra: 'PRIVATE_ARGUMENT' }] }, [/instancePath "\/tripods\/0" \[additionalProperties\]/, /property: "extra"/]],
    [{ tripods: [{ level: 'PRIVATE_ARGUMENT' }] }, [/instancePath "\/tripods\/0\/level" \[type\]: expected number/]],
    [{ tripods: [{}] }, [/instancePath "\/tripods\/0" \[required\]: missing required property: "level"/]],
    [{ tripods: [{ level: 1, label: 'PRIVATE_ARGUMENT', fixed: 'PRIVATE_ARGUMENT', code: 'PRIVATE_ARGUMENT' }] }, [/\[enum\]/, /\[const\]/, /\[pattern\]/]],
  ];
  for (const [args, patterns] of cases) await assert.rejects(registry.call('inspect_spec', args), error => {
    assert.ok(error instanceof Error);
    patterns.forEach(pattern => assert.match(error.message, pattern));
    assert.doesNotMatch(error.message, /PRIVATE_ARGUMENT/);
    assert.deepEqual(safeToolFailure(error), { code: 'ARTIFACT_TOOL_ARGUMENTS_INVALID', message: error.message });
    const trusted = error.message;
    error.message = 'PRIVATE_MUTATED_EXCEPTION';
    assert.equal(safeToolFailure(error).message, trusted);
    assert.doesNotMatch(safeToolFailure(Object.assign(new Error('PRIVATE_FORGED_EXCEPTION'), { code: 'ARTIFACT_TOOL_ARGUMENTS_INVALID' })).message, /PRIVATE_/);
    assert.doesNotMatch(safeToolFailure(new Error(trusted + ' PRIVATE_FORGED_EXCEPTION')).message, /PRIVATE_|instancePath/);
    assert.equal(safeToolFailure(error, true).code, 'ABORTED');
    return true;
  });
  assert.deepEqual(registry.toolCalls, []);
  await registry.call('inspect_spec', { tripods: [{ level: 1 }] });
  assert.equal(registry.toolCalls.length, 1);
});

test('argument diagnostics bound counts and UTF-8 output and preserve the original object size guard', async t => {
  const properties = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field${index}`, { type: 'number' }]));
  const data = await fixture(t, undefined, { ...metadata, inputSchema: { type: 'object', properties, additionalProperties: false } }), registry = await data.registry(); t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec', Object.fromEntries(Object.keys(properties).map(key => [key, 'PRIVATE_VALUE']))), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.match(/^- instancePath/gm)?.length, 5);
    assert.match(error.message, /Additional diagnostics omitted/);
    assert.doesNotMatch(error.message, /field5|PRIVATE_VALUE/);
    return true;
  });
  await assert.rejects(registry.call('inspect_spec', Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}\n\u001b${'\u{1f600}'.repeat(2000)}`, 'PRIVATE_VALUE']))), error => {
    assert.ok(error instanceof Error);
    assert.ok(Buffer.byteLength(error.message) <= 4096);
    assert.match(error.message, /truncated/);
    assert.match(error.message, /more properties omitted/);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE|\u001b|�/);
    return true;
  });
  const longKeys = Array.from({ length: 8 }, (_, index) => `${index}${'p'.repeat(180)}`);
  const bounded = await fixture(t, undefined, { ...metadata, inputSchema: { type: 'object', properties: Object.fromEntries(longKeys.map(key => [key, { type: 'object', additionalProperties: false }])) } });
  const boundedRegistry = await bounded.registry(); t.after(() => boundedRegistry.close());
  const manyErrors = Object.fromEntries(longKeys.map(key => [key, Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`${index}${'q'.repeat(180)}`, 'PRIVATE_VALUE']))]));
  await assert.rejects(boundedRegistry.call('inspect_spec', manyErrors), error => {
    assert.ok(error instanceof Error);
    assert.ok(Buffer.byteLength(error.message) <= 4096);
    assert.match(error.message, /Additional diagnostics omitted/);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    return true;
  });
  for (const args of [null, [], 'text', { value: 'x'.repeat(65536) }]) await assert.rejects(registry.call('inspect_spec', args), { message: 'Tool arguments must be an object of at most 64 KiB.' });
  assert.deepEqual(registry.toolCalls, []);
});

test('large invalid arguments skip exhaustive diagnostics without rejecting valid large arrays', async t => {
  const data = await fixture(t, undefined, { ...metadata, inputSchema: { type: 'object', properties: { values: { type: 'array', uniqueItems: true, items: { type: 'integer' } }, extra: { type: 'object' } }, additionalProperties: false } });
  const registry = await data.registry(); t.after(() => registry.close());
  const started = performance.now();
  await assert.rejects(registry.call('inspect_spec', { values: Array(32700).fill(0) }), /array at instancePath "\/values" exceeds the 512-item diagnostic budget/);
  assert.ok(performance.now() - started < 1000, 'Duplicate diagnostics must not block the event loop with quadratic collection');
  await assert.rejects(registry.call('inspect_spec', { values: [1, 1] }), /instancePath "\/values" \[uniqueItems\]: array items must be unique/);
  await assert.rejects(registry.call('inspect_spec', { values: [1, 1], extra: Object.fromEntries(Array.from({ length: 2050 }, (_, index) => [index, 'PRIVATE_VALUE'])) }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /2048-node diagnostic budget/); assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    return true;
  });
  await registry.call('inspect_spec', { values: Array.from({ length: 1000 }, (_, index) => index) });
  assert.equal(registry.toolCalls.length, 1);
});

test('union and schema-valued additional-property failures retain actionable constraints without values', async t => {
  const inputSchema = { type: 'object', properties: { choice: { anyOf: [{ type: 'number' }, { type: 'boolean' }] }, metadata: { type: 'object', additionalProperties: { type: 'number' } } } };
  const data = await fixture(t, undefined, { ...metadata, inputSchema }), registry = await data.registry(); t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec', { choice: 'PRIVATE_VALUE' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /instancePath "\/choice" \[anyOf\]: must match at least one registered alternative/);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    return true;
  });
  await assert.rejects(registry.call('inspect_spec', { metadata: { count: 'PRIVATE_VALUE' } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /instancePath "\/metadata" \[additionalProperties\]: unexpected or invalid property: "count"/);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    return true;
  });
});

test('argument paths escape property names and disclose ambiguous TypeBox paths instead of inventing a location', async t => {
  const inputSchema = { type: 'object', properties: { 'a~/b': { type: 'number' }, 'a/b': { type: 'number' }, a: { type: 'object', properties: { b: { type: 'number' } } } } };
  const data = await fixture(t, undefined, { ...metadata, inputSchema }), registry = await data.registry(); t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec', { 'a~/b': 'PRIVATE_VALUE' }), /instancePath "\/a~0~1b" \[type\]/);
  await assert.rejects(registry.call('inspect_spec', { 'a/b': 'PRIVATE_VALUE', a: { b: 1 } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /"\/a~1b"/); assert.match(error.message, /"\/a\/b"/); assert.match(error.message, / or /);
    assert.doesNotMatch(error.message, /PRIVATE_VALUE/);
    return true;
  });
});

test('stored manifests and Artifact scope must match before reconnecting script execution', async t => {
  const data = await fixture(t);
  await assert.rejects(createReviewTools({ ...data.options, artifacts: [] }), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
  await data.edit('spec', manifest => { manifest.views!.humanTools!.inspect.metadata.description = 'Changed'; });
  await assert.rejects(data.registry(), { code: 'WORKSPACE_ARTIFACT_MISMATCH' });
});

test('a result and audit are returned only after successful observation persistence', async t => {
  const data = await fixture(t);
  const registry = await createReviewTools({ ...data.options, onCall: async () => { throw new Error('audit failed'); } }); t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec'), /audit failed/); assert.deepEqual(registry.toolCalls, []);
});

test('actual script output preserves text, JSON and normalized images with bounded observations', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const data = await fixture(t, `await mkdir(join(context.outputDir,'frames'));await writeFile(join(context.outputDir,'frames/a.png'),Buffer.from('${png}','base64'));return {content:[{type:'text',text:'frame'},{type:'json',data:{frame:1}},{type:'image',path:'frames/a.png',mimeType:'image/png'}],observation:{kind:'content'}};`);
  const registry = await data.registry(); t.after(() => registry.close());
  const result = await registry.call('inspect_spec');
  assert.deepEqual(result.content[2], { type: 'image', data: png, mimeType: 'image/png' });
  assert.deepEqual(registry.toolCalls[0].observation, { artifactId: 'spec', operation: 'inspect', kind: 'content' });
});

for (const [title, script, error] of [
  ['invalid image bytes', "return {content:[{type:'image',data:'eA==',mimeType:'image/png'}]};", /do not match/],
  ['image outside outputs', "return {content:[{type:'image',path:context.artifactPath+'/content.txt',mimeType:'image/png'}]};", /outside/],
  ['symlink image path', "await mkdir(join(context.outputDir,'source'));await symlink('source',join(context.outputDir,'alias'));return {content:[{type:'image',path:'alias/a.png',mimeType:'image/png'}]};", /symlinks/],
  ['launch observations', "return {content:[{type:'launch',launched:true}],observation:{kind:'content'}};", /alone is not/],
  ['oversized text', "return {content:[{type:'text',text:'x'.repeat(65537)}]};", /64 KiB/],
  ['non JSON output', "process.stdout.write('log before result');return {content:[{type:'text',text:'x'}]};", /JSON/],
  ['process failure', "process.stderr.write('private error');process.exit(3);", /nonzero/],
] as const) test(`script result rejects ${title} without recording an observation`, async t => {
  const data = await fixture(t, script), registry = await data.registry(); t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec'), error); assert.equal(registry.toolCalls.length, 0);
});

test('script timeout, cancellation and close stop active processes', async t => {
  const data = await fixture(t, 'await new Promise(()=>{});return {};', { ...metadata, timeoutMs: 150 });
  // An active interval keeps the real script running while cancellation is tested.
  const filename = join(data.repoPath, 'spec/inspect.mjs'); await writeFile(filename, (await readFile(filename, 'utf8')).replace('await new Promise(()=>{})', 'await new Promise(()=>setInterval(()=>{},1000))'));
  let registry = await data.registry();
  await assert.rejects(registry.call('inspect_spec'), { code: 'ARTIFACT_TOOL_TIMEOUT' }); await registry.close();
  const abort = new AbortController(); registry = await createReviewTools({ ...data.options, signal: abort.signal });
  const call = registry.call('inspect_spec'); setTimeout(() => abort.abort(), 30); await assert.rejects(call); await registry.close();
  registry = await data.registry(); const closing = registry.call('inspect_spec'); const rejected = assert.rejects(closing); await delay(20); await registry.close(); await rejected;
});

test('a crashed script kills surviving children before its failed call settles', { skip: process.platform === 'win32' }, async t => {
  const data = await fixture(t, `const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});await writeFile(join(context.outputDir,'pid'),String(child.pid));await new Promise(r=>setTimeout(r,150));process.exit(2);`);
  const registry = await data.registry();
  await assert.rejects(registry.call('inspect_spec')); await registry.close();
  const directories = await (await import('node:fs/promises')).readdir(registry.outputDir);
  const pid = Number(await readFile(join(registry.outputDir, directories[0], 'pid'), 'utf8'));
  await delay(30);
  try { assert.match(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }), /^Z/); } catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 1)) throw error; }
});

test('outputs cannot create any directory inside reviewed input, including through symlink ancestors', async t => {
  const data = await fixture(t);
  await symlink(data.repoPath, join(data.root, 'linked'));
  for (const runDir of [join(data.repoPath, 'new-output'), join(data.root, 'linked/new-output')]) await assert.rejects(createReviewTools({ ...data.options, runDir }), /outside reviewed input/);
  await assert.rejects(readFile(join(data.repoPath, 'new-output')), { code: 'ENOENT' });
});

test('default script CLI resolves mount chains to actual files and lists logical mounts without writing links', async t => {
  const data = await artifactFixture(t), command = resolve('packages/default-tools/dist/script.js');
  const scriptView = (operation: string) => ({ metadata: { ...metadata, inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } }, script: { command: 'node', args: [command, operation] } });
  await data.write('a', { name: 'a', mounts: { peer: 'b' }, views: { humanTools: { read: scriptView('read'), list: scriptView('list') } } });
  await data.write('b', { name: 'b', mounts: { back: 'a' } }, { 'content.txt': 'Mounted content\n' });
  const config = await data.config(), { resolveArtifactScope } = await import('../src/artifacts/scope.js');
  const registry = await createReviewTools({ worktreePath: data.repoPath, ...resolveArtifactScope(config.artifacts, ['a']), configManifest: config.configManifest, audience: 'human' }); t.after(() => registry.close());
  assert.equal((json(await registry.call('read_a', { path: 'peer/back/peer/content.txt' })) as any).content, 'Mounted content\n');
  assert.ok((json(await registry.call('list_a')) as any).entries.some((entry: any) => entry.name === 'peer' && entry.kind === 'mount'));
  await assert.rejects(readFile(join(data.repoPath, 'a/peer')), { code: 'ENOENT' });
  await assert.rejects(registry.call('read_a', { path: 'peer/../content.txt' }));
});

test('MCP projects script schemas and audited native content using the standard registry', async t => {
  const data = await fixture(t); await data.edit('spec', m => { m.views!.agentTools = m.views!.humanTools; m.critics![0].profile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' }; });
  const request = (await data.requests())[0], manifestPath = join(data.root, 'mcp.json'), input = new PassThrough(), output = new PassThrough(); let messages = '';
  output.on('data', chunk => { messages += chunk; });
  await writeFile(manifestPath, JSON.stringify({ ...request, worktreePath: data.repoPath, runDir: join(data.root, 'mcp-output') }));
  const serving = serveArtifactMcp({ manifestPath, input, output });
  input.end([['initialize', {}], ['tools/list', {}], ['tools/call', { name: 'inspect_spec', arguments: {} }]].map(([method, params], id) => JSON.stringify({ jsonrpc: '2.0', id, method, params })).join('\n') + '\n');
  await serving; const replies = messages.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[1].result.tools[0].name, 'inspect_spec'); assert.equal(replies[2].result.content[0].text, 'observed');
});

test('explicit tool diagnosis distinguishes execution failure, result normalization and integrity failure', async t => {
  for (const [script, stage] of [["return {content:[{type:'image',data:'eA==',mimeType:'image/png'}]};", 'normalize-result'], ["process.exit(3);", 'execute'], ["await writeFile(join(context.artifactPath,'changed'),'x');return {content:[{type:'text',text:'x'}]};", 'input-integrity']] as const) {
    const data = await fixture(t, script);
    const report = await diagnoseArtifactTools({ ...data, artifactId: 'spec', audience: 'human', toolName: 'inspect', execute: true });
    assert.equal(report.ok, false); assert.equal(report.checks.at(-1)?.stage, stage); assert.equal(report.result, undefined);
  }
});
test('public defineTool infers typed arguments without executing the factory', () => {
  const tool = defineTool({
    metadata: { description: 'Inspect {artifactName}.', inputSchema: { type: 'object', properties: { frame: { type: 'integer' }, channels: { type: 'array', items: { type: 'string', enum: ['color', 'depth'] } }, overlay: { type: 'boolean' } }, required: ['frame', 'channels'], additionalProperties: false }, resultKinds: ['json'], observation: 'none' },
    execute(_context, args) {
      const frame: number = args.frame;
      const channel: 'color' | 'depth' | undefined = args.channels[0];
      const overlay: boolean | undefined = args.overlay;
      // @ts-expect-error A registered boolean is not a string.
      const invalid: string = args.overlay;
      void invalid;
      return { content: [{ type: 'json', data: { frame, channel: channel ?? 'color', overlay: overlay ?? false } }] };
    },
  });
  assert.equal(typeof tool.execute, 'function');
});


for (const fail of [false, true]) test(`tool timing reports a real ${fail ? 'failed' : 'successful'} process without entering observation records`, async t => {
  const data = await fixture(t, `await new Promise(resolve=>setTimeout(resolve,35));${fail ? "process.stderr.write('PRIVATE_DIAGNOSTIC');process.exit(2);" : "return {content:[{type:'text',text:'observed'}],observation:{kind:'content'}};"}`);
  const diagnostics: unknown[] = [];
  const registry = await createReviewTools({ ...data.options, onExecution: diagnostic => { diagnostics.push(diagnostic); } }); t.after(() => registry.close());
  await assert.rejects(registry.call('unknown')); await assert.rejects(registry.call('inspect_spec', { extra: true }));
  assert.deepEqual(diagnostics, []);
  if (fail) await assert.rejects(registry.call('inspect_spec'), /nonzero/); else await registry.call('inspect_spec');
  assert.equal(diagnostics.length, 1);
  const diagnostic = diagnostics[0] as { startedAt: string; durationMs: number; outcome: string; name: string };
  assert.equal(diagnostic.name, 'inspect_spec'); assert.equal(diagnostic.outcome, fail ? 'error' : 'success');
  assert.ok(Number.isFinite(Date.parse(diagnostic.startedAt))); assert.ok(diagnostic.durationMs >= 35);
  assert.doesNotMatch(JSON.stringify(registry.toolCalls), /durationMs|startedAt|outcome/);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_DIAGNOSTIC/);
});


test('failed optional telemetry never withholds successful tool content or its observation', async t => {
  const data = await fixture(t);
  const registry = await createReviewTools({ ...data.options, onExecution: () => { throw new Error('Controlled diagnostic write failure'); } }); t.after(() => registry.close());
  const result = await registry.call('inspect_spec');
  assert.equal(result.observation?.kind, 'content');
  assert.equal(registry.toolCalls[0].observation?.kind, 'content');
});

test('explicit script errors are bounded UTF-8 text, audited without observations, and require audit persistence', async t => {
  const data = await fixture(t, "process.stderr.write('PRIVATE_STDERR');return {isError:true,content:[{type:'text',text:'Unknown skill 16145'}]};", { ...metadata, resultKinds: ['image'] });
  const diagnostics: Array<{ outcome: string }> = [];
  const registry = await createReviewTools({ ...data.options, onExecution: diagnostic => { diagnostics.push(diagnostic); } }); t.after(() => registry.close());
  assert.deepEqual(await registry.call('inspect_spec'), { isError: true, content: [{ type: 'text', text: 'Unknown skill 16145' }] });
  assert.equal(diagnostics[0].outcome, 'error');
  assert.equal(registry.toolCalls[0].isError, true);
  assert.deepEqual(registry.toolCalls[0].observation, { artifactId: 'spec', operation: 'inspect' });
  assert.doesNotMatch(JSON.stringify(registry.toolCalls), /Unknown skill|PRIVATE_STDERR/);
  const failingAudit = await createReviewTools({ ...data.options, onCall: () => { throw new Error('audit failed'); } }); t.after(() => failingAudit.close());
  await assert.rejects(failingAudit.call('inspect_spec'), /audit failed/);
  assert.deepEqual(failingAudit.toolCalls, []);
  const report = await diagnoseArtifactTools({ repoPath: data.repoPath, stateDir: data.stateDir, artifactId: 'spec', audience: 'human', toolName: 'inspect', execute: true });
  assert.equal(report.ok, false); assert.ok(report.checks.some(check => check.code === 'ARTIFACT_TOOL_DOMAIN_ERROR'));
  assert.equal(report.result?.isError, true); assert.deepEqual(report.result?.content, [{ type: 'text', text: 'Unknown skill 16145' }]);
});

for (const value of [
  { isError: true, content: [{ type: 'text', text: 'domain error' }], observation: { kind: 'content' } },
  { isError: true, content: [{ type: 'text', text: 'domain error' }], extra: 'private' },
  { isError: true, content: [{ type: 'json', data: 'error' }] },
  { isError: true, content: [{ type: 'text', text: ' ' }] },
  { isError: true, content: [{ type: 'text', text: '\u00e9'.repeat(32769) }] },
]) test('malformed or oversized author errors never record an observation', async t => {
  const data = await fixture(t, `return ${JSON.stringify(value)};`), registry = await data.registry(); t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec'), /author-controlled tool error/);
  assert.deepEqual(registry.toolCalls, []);
});


for (const malformed of [false, true]) test(`MCP ${malformed ? 'withholds malformed stdout' : 'preserves explicit domain error text'}`, async t => {
  const data = await fixture(t, malformed ? "process.stdout.write('PRIVATE_STDOUT_CREDENTIAL');return {};" : "return {isError:true,content:[{type:'text',text:'Unknown skill 16145'}]};");
  await data.edit('spec', m => { m.views!.agentTools = m.views!.humanTools; m.critics![0].profile = { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' }; });
  const request = (await data.requests())[0], manifestPath = join(data.root, 'mcp-errors.json'), input = new PassThrough(), output = new PassThrough(); let messages = '';
  output.on('data', chunk => { messages += chunk; });
  await writeFile(manifestPath, JSON.stringify({ ...request, worktreePath: data.repoPath, runDir: join(data.root, 'mcp-errors') }));
  const serving = serveArtifactMcp({ manifestPath, input, output });
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_spec' } }) + '\n');
  await serving; const result = JSON.parse(messages).result;
  assert.equal(result.isError, true); assert.doesNotMatch(messages, /PRIVATE_STDOUT_CREDENTIAL/);
  if (!malformed) assert.equal(result.content[0].text, 'Unknown skill 16145');
});

test('authored error text preserves UTF-8 characters split across subprocess chunks at the byte limit', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'spec/inspect.mjs'), `const text='x'.repeat(65532)+'\\u{1f600}';const bytes=Buffer.from(JSON.stringify({isError:true,content:[{type:'text',text}]}));const split=bytes.indexOf(Buffer.from('\\u{1f600}'))+1;process.stdout.write(bytes.subarray(0,split));await new Promise(resolve=>setTimeout(resolve,40));process.stdout.write(bytes.subarray(split));`);
  const request = (await data.requests())[0], registry = await createReviewTools({ ...data.options, ...request }); t.after(() => registry.close());
  const result = await registry.call('inspect_spec');
  assert.equal(result.isError, true); assert.equal(result.content[0].type, 'text');
  if (result.content[0].type === 'text') assert.equal(result.content[0].text, 'x'.repeat(65532) + '\u{1f600}');
});

test('tool completion telemetry measures every content kind without copying response payloads', async t => {
  const content = [{ type: 'text', text: 'é' }, { type: 'text', text: 'ab' }, { type: 'json', data: { value: 'λ' } },
    { type: 'image', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), mimeType: 'image/png' }, { type: 'launch', launched: true }];
  const data = await fixture(t, `return ${JSON.stringify({ content })};`);
  const events: import('../src/tools/runner.js').ToolExecutionDiagnostic[] = [];
  const registry = await createReviewTools({ ...data.options, onExecution: event => { events.push(event); } }); t.after(() => registry.close());
  await registry.call('inspect_spec');
  const expected = { text: 4, json: Buffer.byteLength(JSON.stringify({ value: 'λ' })), image: 8, launch: Buffer.byteLength(JSON.stringify({ kind: 'launch', launched: true })) };
  assert.deepEqual(events[0].contentBytesByType, expected);
  assert.equal(events[0].contentBytes, Object.values(expected).reduce((a, b) => a + b));
  assert.doesNotMatch(JSON.stringify(events), /mimeType|value|launched/);
  assert.equal('contentBytes' in registry.toolCalls[0], false);
});

for (const authorError of [false, true]) test(`tool error payload bytes distinguish no response from author errors (${authorError})`, async t => {
  const data = await fixture(t, authorError ? "return {isError:true,content:[{type:'text',text:'unavailable'}]};" : "throw new Error('failed');");
  const events: import('../src/tools/runner.js').ToolExecutionDiagnostic[] = [];
  const registry = await createReviewTools({ ...data.options, onExecution: event => { events.push(event); } }); t.after(() => registry.close());
  if (authorError) await registry.call('inspect_spec'); else await assert.rejects(registry.call('inspect_spec'));
  assert.equal(events[0].outcome, 'error');
  assert.equal(events[0].contentBytes, authorError ? 11 : 0);
  assert.deepEqual(events[0].contentBytesByType, { text: authorError ? 11 : 0, json: 0, image: 0, launch: 0 });
});
