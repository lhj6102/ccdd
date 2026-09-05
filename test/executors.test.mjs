import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutorRegistry } from '../src/executors/index.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-executor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktreePath = join(dir, 'snapshot');
  await mkdir(join(worktreePath, 'tests'), { recursive: true });
  await writeFile(join(worktreePath, 'why.md'), '# Why\nSelect two tasks.');
  await writeFile(join(worktreePath, 'spec.md'), '# Spec\nSelect two tasks.');
  const request = {
    id: 'request-1', criticId: 'spec-why', title: 'Spec이 Why에 부합하는가', snapshotHash: 'a'.repeat(64),
    artifacts: [{ id: 'why', type: 'markdown', path: 'why.md' }, { id: 'spec', type: 'markdown', path: 'spec.md' }],
    artifactTypes: { markdown: { viewer: 'text' }, code: { viewer: 'files' } },
    payload: { instruction: 'Compare {why} and {spec}.' },
    profile: { kind: 'agent', provider: 'codex', model: 'test-model', reasoning: 'medium', timeoutMs: 5_000 },
  };
  return { dir, request, worktreePath, runDir: join(dir, 'run') };
}

async function fakeProvider(dir, mode = 'valid') {
  const path = join(dir, `fake-provider-${mode}.mjs`);
  await writeFile(path, `#!${process.execPath}
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2);
const config=args.filter((x,i)=>args[i-1]==='-c');
const configValue=key=>JSON.parse(config.find(x=>x.startsWith(key+'=')).slice(key.length+1));
await writeFile(${JSON.stringify(join(dir, 'provider-args.json'))},JSON.stringify(args));
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(!prompt.includes('Review payload:'))process.exit(2);
console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_REASONING_DO_NOT_EXPOSE'}}));
if(${JSON.stringify(mode)}==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
if(${JSON.stringify(mode)}==='exit')process.exit(7);
const mcpArgs=configValue('mcp_servers.ccdd_artifacts.args');
const mcp=spawn(configValue('mcp_servers.ccdd_artifacts.command'),mcpArgs);
const lines=createInterface({input:mcp.stdout});let seq=0;const pending=new Map();
lines.on('line',line=>{const m=JSON.parse(line);pending.get(m.id)(m);pending.delete(m.id);});
const call=(method,params)=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
await call('initialize',{protocolVersion:'2024-11-05'});
const tools=(await call('tools/list')).result.tools;
if(${JSON.stringify(mode)}!=='no-tools')for(const tool of tools)if(tool.name.startsWith('read_'))await call('tools/call',{name:tool.name,arguments:{}});
mcp.stdin.end();
const result=${JSON.stringify(mode)}==='malformed'?'not json':JSON.stringify({verdict:'GREEN',summary:'두 문서가 일치합니다.',evidence:['why.md와 spec.md는 모두 두 작업을 선택합니다.']});
await writeFile(args[args.indexOf('--output-last-message')+1],result);
`);
  await chmod(path, 0o700);
  return path;
}

test('Codex adapter starts a real provider process with scoped MCP and keeps only final result and tool provenance', async t => {
  const data = await fixture(t);
  const codexPath = await fakeProvider(data.dir);
  const registry = createExecutorRegistry({ codexPath });
  const events = [];
  const result = await registry.execute(data.request, { ...data, onEvent: event => events.push(event) });
  assert.equal(result.verdict, 'GREEN');
  assert.deepEqual(result.toolCalls.map(x => x.name), ['read_why', 'read_spec']);
  assert.equal(result.provider, 'codex');
  assert.equal(result.model, 'test-model');
  assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_REASONING/);
  const args = JSON.parse(await readFile(join(data.dir, 'provider-args.json')));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  assert.ok(args.includes('shell_tool'));
  assert.ok(events.some(x => x.type === 'artifact.tools.ready'));
});

test('provider errors, malformed final JSON and missing observation are ERROR conditions rather than fabricated RED verdicts', async t => {
  for (const [mode, expected] of [['exit', /provider failed/], ['malformed', /final JSON/], ['no-tools', /did not inspect/]]) {
    const data = await fixture(t);
    const registry = createExecutorRegistry({ codexPath: await fakeProvider(data.dir, mode) });
    await assert.rejects(registry.execute(data.request, data), expected);
  }
});

test('agent execution aborts on timeout and external cancellation', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry({ codexPath: await fakeProvider(data.dir, 'hang') });
  await assert.rejects(registry.execute({ ...data.request, profile: { ...data.request.profile, timeoutMs: 150 } }, data), /timed out/);
  const abort = new AbortController();
  const promise = registry.execute(data.request, { ...data, signal: abort.signal });
  setTimeout(() => abort.abort(), 150);
  await assert.rejects(promise, /aborted/);
});

test('code runner evaluates actual Node tests and distinguishes pass from assertion failure', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry();
  const request = { ...data.request, profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs'] } };
  await writeFile(join(data.worktreePath, 'tests/check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('count',()=>assert.equal(2,2));");
  assert.equal((await registry.execute(request, data)).verdict, 'GREEN');
  await writeFile(join(data.worktreePath, 'tests/check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('count',()=>assert.equal(3,2));");
  const result = await registry.execute(request, data);
  assert.equal(result.verdict, 'RED');
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stdout, /count/);
  assert.equal((await registry.canExecute({ profile: { kind: 'runtime', command: 'node', args: ['-e', 'process.exit()'] } })).ok, false);
});

test('Human executor requires an explicit alarm method and dispatches configured notification without completing review', async () => {
  const request = { id: 'human-1', profile: { kind: 'human' } };
  assert.equal((await createExecutorRegistry().canExecute(request)).ok, false);
  const received = [];
  const registry = createExecutorRegistry({ alarmMethods: [{ id: 'broker-inbox', notify: async request => received.push(request.id) }] });
  assert.equal((await registry.canExecute(request)).ok, true);
  assert.deepEqual(await registry.notifyHuman(request), { alarmMethods: ['broker-inbox'] });
  assert.deepEqual(received, ['human-1']);
  await assert.rejects(registry.execute(request, {}), /claim\/result/);
  assert.throws(() => createExecutorRegistry({ alarmMethods: ['email'] }), /alarm method/);
});

test('concurrent runtime reviews share input while writing to separate per-review output and temporary directories', async t => {
  const data = await fixture(t);
  await writeFile(join(data.worktreePath, 'tests/output.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('isolated output', async () => {
  assert.notEqual(process.cwd(), process.env.CCDD_OUTPUT_DIR);
  assert.equal(tmpdir(), process.env.CCDD_TMP_DIR);
  await writeFile(join(process.env.CCDD_OUTPUT_DIR, 'result.json'), JSON.stringify({cwd:process.cwd(), output:process.env.CCDD_OUTPUT_DIR, temporary:tmpdir(), home:process.env.HOME}));
  await writeFile(join(tmpdir(), 'temporary.txt'), 'scratch');
});
`);
  const request = { ...data.request, profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/output.test.mjs'] } };
  const registry = createExecutorRegistry();
  const dirs = [join(data.dir, 'review-one'), join(data.dir, 'review-two')];
  const results = await Promise.all(dirs.map(runDir => registry.execute(request, { ...data, runDir })));
  assert.deepEqual(results.map(result => result.verdict), ['GREEN', 'GREEN']);
  const outputs = await Promise.all(dirs.map(runDir => readFile(join(runDir, 'output/result.json'), 'utf8').then(JSON.parse)));
  assert.equal(outputs[0].cwd, outputs[1].cwd);
  assert.notEqual(outputs[0].output, outputs[1].output);
  assert.notEqual(outputs[0].temporary, outputs[1].temporary);
  assert.notEqual(outputs[0].home, outputs[1].home);
  await assert.rejects(readFile(join(data.worktreePath, 'result.json')));
});

test('executors reject output directories inside input before creating files', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry({ codexPath: await fakeProvider(data.dir) });
  const requests = [data.request, { ...data.request, profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs'] } }];
  for (const request of requests) {
    const runDir = join(data.worktreePath, `should-not-exist-${request.profile.kind}`);
    await assert.rejects(registry.execute(request, { ...data, runDir }), /outside the review workspace/);
    await assert.rejects(access(runDir));
  }
});
