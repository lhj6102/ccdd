import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readWorkspaceConfig } from '../src/broker/config.js';
import { createBroker } from '../src/broker/index.js';
import { prepareReviewRequests } from '../src/requester/index.js';
import { createReviewTools, describeReviewTools } from '../src/tools/runner.js';
import { defineTool } from '../src/sdk.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';

const metadata = {
  description: 'Inspect {artifactName}.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  resultKinds: ['text', 'json', 'image', 'launch'], observation: 'content',
};
async function fixture(t: TestContext, options: { execute?: string; prelude?: string; meta?: object; tools?: string; audience?: 'human' | 'agent' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-tool-runtime-'));
  const repoPath = join(dir, 'project');
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'spec.md'), '# Requirements\n');
  const configPath = join(repoPath, 'ccdd.config.ts');
  const tools = options.tools ?? `inspect: { metadata: ${JSON.stringify(options.meta ?? metadata)}, ${options.execute ?? "execute() { return { content: [{ type: 'text', text: 'observed' }], observation: { kind: 'content' } }; }"} }`;
  const audience = options.audience ?? 'human';
  const source = `${options.prelude ?? ''}
export default async () => ({
  artifacts: { spec: { type: 'custom', path: 'spec.md' } },
  artifactTypes: { custom: { ${audience}Tools: { ${tools} } } },
  critics: [{ id: 'review', title: 'Review', target: 'spec', deps: [], profile: ${JSON.stringify(audience === 'human' ? { kind: 'human' } : { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium' })}, payload: { instruction: 'Review spec.' } }]
});`;
  await writeFile(configPath, source);
  t.after(() => removeOwnedWorkspaceTree(dir));
  const optionsFor = async () => {
    const request = (await prepareReviewRequests({ repoPath, snapshotHash: 'a'.repeat(64) }))[0];
    return { worktreePath: repoPath, artifacts: request.artifacts, artifactTypes: request.artifactTypes, configManifest: request.configManifest, audience, runDir: join(dir, 'outputs') };
  };
  return { dir, repoPath, configPath, source, optionsFor };
}

test('TS config loads local helpers, preserves schemas, and never executes a registered tool during admission', async t => {
  const data = await fixture(t, { prelude: "import { helper } from './helper.js';", tools: 'inspect: helper' });
  const marker = join(data.dir, 'executed');
  await writeFile(join(data.repoPath, 'helper.ts'), `import { writeFile } from 'node:fs/promises';
export const helper = { metadata: ${JSON.stringify(metadata)}, async execute() { await writeFile(${JSON.stringify(marker)}, 'yes'); return { content: [{ type: 'text', text: 'helper' }], observation: { kind: 'content' } }; } };`);
  const options = await data.optionsFor();
  assert.deepEqual(options.configManifest?.modules.map(item => item.path), ['ccdd.config.ts', 'helper.ts']);
  assert.equal(JSON.stringify(options.configManifest).includes('execute'), false);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const registry = await createReviewTools(options);
  t.after(() => registry.close());
  assert.equal(registry.tools[0].description, 'Inspect spec.');
  assert.deepEqual(registry.tools[0].inputSchema, metadata.inputSchema);
  assert.equal((await registry.preflight())[0].ok, true);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal((await registry.call('inspect_spec')).content[0].text, 'helper');
  assert.equal(await readFile(marker, 'utf8'), 'yes');
});

test('submission evaluates the config once for both graph and request manifests', async t => {
  const data = await fixture(t);
  const marker = join(data.dir, 'loads');
  await writeFile(data.configPath, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'load\\n');\n${data.source}`);
  const broker = createBroker({ repoPath: data.repoPath, stateDir: join(data.dir, 'state'), executors: { canExecute: () => ({ ok: true }), notifyHuman: async () => {}, execute: async () => { throw new Error('Not executed during admission'); } } });
  t.after(() => broker.close());
  const run = await broker.submit({ mode: 'copy', requesterId: 'unit-test' });
  assert.equal(await readFile(marker, 'utf8'), 'load\n');
  assert.ok(run.requests[0].configManifest);
  assert.deepEqual(Object.keys(run.graph!.artifacts), ['spec']);
});

test('each tool registry rehydrates a fresh closure and rejects changed snapshot declarations', async t => {
  const data = await fixture(t, { prelude: 'let count = 0;', execute: "execute() { return { content: [{ type: 'json', data: ++count }] }; }" });
  const options = await data.optionsFor();
  for (let index = 0; index < 2; index++) {
    const registry = await createReviewTools(options);
    try {
      assert.equal((await registry.call('inspect_spec')).content[0].data, 1);
      assert.equal((await registry.call('inspect_spec')).content[0].data, 2);
    } finally { await registry.close(); }
  }
  await writeFile(data.configPath, data.source.replace('Inspect {artifactName}.', 'Changed {artifactName}.'));
  await assert.rejects(createReviewTools(options), /manifest does not match/);
});

test('config conflict is rejected before evaluation and empty audience tools never gain defaults', async t => {
  const data = await fixture(t, { tools: '' });
  const { config } = await readWorkspaceConfig(data.repoPath);
  assert.deepEqual(config.configManifest?.types.custom.humanTools, {});
  assert.deepEqual(describeReviewTools({ artifacts: [{ id: 'spec', type: 'custom', path: 'spec.md' }], configManifest: config.configManifest!, audience: 'human' }), []);
  await assert.rejects(data.optionsFor(), /no usable human tools/);
  await writeFile(join(data.repoPath, 'ccdd.config.json'), '{}');
  await writeFile(data.configPath, "throw new Error('MUST_NOT_EXECUTE');");
  await assert.rejects(readWorkspaceConfig(data.repoPath), /Both ccdd.config/);
});

test('configuration imports must resolve inside the snapshot, including deferred imports', async t => {
  const data = await fixture(t);
  await writeFile(join(data.dir, 'external.ts'), 'export const value = 1;');
  await writeFile(data.configPath, `import '../external.ts';\n${data.source}`);
  await assert.rejects(readWorkspaceConfig(data.repoPath), /imports must resolve inside/);
  await writeFile(data.configPath, data.source.replace("execute() { return", "async execute() { await import('../external.ts'); return"));
  const registry = await createReviewTools(await data.optionsFor());
  t.after(() => registry.close());
  await assert.rejects(registry.call('inspect_spec'), /imports must resolve inside/);
  assert.equal(registry.toolCalls.length, 0);
});

test('malformed registration and schema are rejected at admission', async t => {
  const cases = [
    'inspect: {}',
    `inspect: { metadata: ${JSON.stringify(metadata)}, execute: 'not a function' }`,
    `inspect: { metadata: ${JSON.stringify({ ...metadata, inputSchema: { type: 'object', $ref: 'remote' } })}, execute() {} }`,
    `inspect: { metadata: ${JSON.stringify({ ...metadata, description: '{unknown}' })}, execute() {} }`,
  ];
  for (const tools of cases) {
    const data = await fixture(t, { tools });
    await assert.rejects(readWorkspaceConfig(data.repoPath), /Invalid tool definition|Unsupported tool schema|description requires/);
  }
});

test('strict arguments prevent execution and tool scope rejects traversal and symlinks', async t => {
  const schema = { type: 'object', properties: { frame: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' }, channel: { type: 'string', enum: ['color', 'depth'] } }, required: ['frame', 'enabled', 'channel'], additionalProperties: false };
  const data = await fixture(t, { prelude: 'let count = 0;', meta: { ...metadata, inputSchema: schema }, execute: "execute(context, args) { return { content: [{ type: 'json', data: { ...args, count: ++count } }] }; }" });
  const registry = await createReviewTools(await data.optionsFor());
  t.after(() => registry.close());
  for (const args of [{ frame: '1', enabled: true, channel: 'color' }, { frame: 1, enabled: 'false', channel: 'color' }, { frame: 1, enabled: true, channel: 'unknown' }, { frame: 1, enabled: true, channel: 'color', extra: 1 }]) {
    await assert.rejects(registry.call('inspect_spec', args), /input schema/);
  }
  assert.deepEqual((await registry.call('inspect_spec', { frame: 2, enabled: false, channel: 'depth' })).content[0].data, { frame: 2, enabled: false, channel: 'depth', count: 1 });
  const scoped = await fixture(t, { execute: "async execute(context) { await context.resolvePath('../private'); return { content: [{ type: 'text', text: 'unreachable' }] }; }" });
  const scopedRegistry = await createReviewTools(await scoped.optionsFor());
  t.after(() => scopedRegistry.close());
  await assert.rejects(scopedRegistry.call('inspect_spec'), /does not accept an internal path/);
  await symlink(join(data.repoPath, 'spec.md'), join(scoped.repoPath, 'link'));
  await writeFile(scoped.configPath, scoped.source.replace("path: 'spec.md'", "path: 'link'"));
  await assert.rejects(readWorkspaceConfig(scoped.repoPath), /escapes|symlinks/);
});

test('images cannot refer to inputs or masquerade as a different MIME type and launches do not prove observation', async t => {
  for (const execute of [
    "execute(context) { return { content: [{ type: 'image', path: context.artifactPath, mimeType: 'image/png' }] }; }",
    "execute() { return { content: [{ type: 'image', data: 'bm90IGEgcG5n', mimeType: 'image/png' }] }; }",
    "execute() { return { content: [{ type: 'launch', launched: true }], observation: { kind: 'content' } }; }",
  ]) {
    const data = await fixture(t, { execute });
    const registry = await createReviewTools(await data.optionsFor());
    try {
      await assert.rejects(registry.call('inspect_spec'), /outside the tool output|do not match|alone is not a content observation/);
      assert.equal(registry.toolCalls.length, 0);
    } finally { await registry.close(); }
  }
});

test('a crashed config host cleans up a surviving command before the registry closes', async t => {
  const data = await fixture(t);
  const childPidPath = join(data.dir, 'child-pid');
  await writeFile(data.configPath, `import { spawn } from 'node:child_process'; import { writeFile } from 'node:fs/promises';\n${data.source.replace("execute() { return", `async execute() {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await writeFile(${JSON.stringify(childPidPath)}, String(child.pid));
    await new Promise(resolve => setTimeout(resolve, 200));
    process.exit(2);
    return`)} `);
  const registry = await createReviewTools(await data.optionsFor());
  await assert.rejects(registry.call('inspect_spec'), /host exited/);
  await registry.close();
  const pid = Number(await readFile(childPidPath, 'utf8'));
  assert.ok(pid > 0);
  // An orphan may briefly remain as a non-running zombie until the OS reaps its PID.
  for(let attempt=0;attempt<25;attempt++){
    try{process.kill(pid,0);}catch(error){assert.equal((error as NodeJS.ErrnoException).code,'ESRCH');return;}
    await delay(20);
  }
  try {
    const state=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();
    assert.match(state,/^Z/,'A surviving subprocess is still executing after registry.close()');
  } catch(error) {
    // ps exits 1 when the PID disappears between the liveness check and the process query.
    if(error&&typeof error==='object'&&'status' in error&&error.status===1)return;
    throw error;
  }
});

test('background host cleanup failures are observed while explicit close retains the rejection', async t => {
  if(process.platform==='win32')return;
  const data=await fixture(t);
  const hostPidPath=join(data.dir,'host-pid');
  await writeFile(data.configPath,`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(hostPidPath)},String(process.pid));\n${data.source.replace('execute() { return','execute() { process.exit(2); return')}`);
  const registry=await createReviewTools(await data.optionsFor());
  const hostPid=Number(await readFile(hostPidPath,'utf8'));
  const kill=process.kill;
  // Simulate a group the OS still reports after termination. Signals still target only this test's host.
  process.kill=((pid:number,signal?:number|NodeJS.Signals)=>pid===-hostPid&&signal===0?true:kill(pid,signal)) as typeof process.kill;
  try{
    await assert.rejects(registry.call('inspect_spec'),/host exited/);
    await delay(2300);
    await assert.rejects(registry.close(),{code:'ARTIFACT_TOOL_CLEANUP_FAILED'});
  }finally{process.kill=kill;await registry.close().catch(()=>{});}
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
