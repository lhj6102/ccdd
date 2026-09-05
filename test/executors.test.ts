import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutorRegistry, validateResult } from '../src/executors/index.js';
import type { AgentProfile, ReviewEnvelope, ReviewRequest, ExecutionEvent } from '../src/contracts.js';
import { artifactStream } from './pi-fixture.js';
import type { ArtifactStreamOptions } from './pi-fixture.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-executor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktreePath = join(dir, 'snapshot');
  await mkdir(join(worktreePath, 'tests'), { recursive: true });
  await writeFile(join(worktreePath, 'why.md'), '# Why\nSelect two tasks.');
  await writeFile(join(worktreePath, 'spec.md'), '# Spec\nSelect two tasks.');
  const request: ReviewEnvelope & { profile: AgentProfile } = {
    repoId: 'test', dependsOn: null, criticId: 'spec-why', title: 'Spec이 Why에 부합하는가', snapshotHash: 'a'.repeat(64),
    artifacts: [{ id: 'why', type: 'markdown', path: 'why.md' }, { id: 'spec', type: 'markdown', path: 'spec.md' }],
    artifactTypes: { markdown: { viewer: 'text', agentTools: { read: {} }, humanTools: { read: {} } }, code: { viewer: 'files', agentTools: { list: {}, read: {} }, humanTools: { list: {}, read: {} } } },
    payload: { instruction: 'Compare {why} and {spec}.' },
    profile: { kind: 'agent', provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'medium', timeoutMs: 5_000 },
  };
  return { dir, request, worktreePath, runDir: join(dir, 'run') };
}

test('Pi Agent uses exact profile and only scoped Artifact tools; result and audit exclude thinking', async t => {
  const data = await fixture(t);
  const events: ExecutionEvent[] = [];
  let calls = 0;
  const registry = createExecutorRegistry({ streamFn: artifactStream({ onRequest: ({ model, context, options }) => {
    calls++;
    assert.equal(model.provider, data.request.profile.provider); assert.equal(model.id, data.request.profile.model);
    assert.equal(options?.reasoning, 'medium');
    assert.deepEqual(context.tools?.map(tool => tool.name), ['read_why', 'read_spec']);
  } }) });
  const result = await registry.execute(data.request, { ...data, onEvent: event => { events.push(event); } });
  assert.equal(result.verdict, 'GREEN');
  assert.deepEqual(result.toolCalls?.map(x => x.name), ['read_why', 'read_spec']);
  assert.equal(result.provider, 'openai-codex'); assert.equal(result.model, 'gpt-6-astra');
  assert.ok(calls >= 2);
  assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_REASONING|SECRET_TOKEN/);
  assert.ok(events.some(x => x.type === 'artifact.tools.ready'));
  assert.equal(events.filter(x => x.type === 'artifact.tool.called').length, 2);
});

test('provider errors, invalid final schema and missing observations fail instead of becoming RED', async t => {
  const modes: [ArtifactStreamOptions['mode'], RegExp][] = [
    ['unknown-error', /Provider 실행/], ['malformed', /final JSON/], ['no-tools', /did not inspect/], ['beyond-eof', /did not inspect/],
  ];
  for (const [mode, expected] of modes) {
    const data = await fixture(t);
    await assert.rejects(createExecutorRegistry({ streamFn: artifactStream({ mode }) }).execute(data.request, data), expected);
  }
  for (const result of [{ verdict:'GREEN', summary:'ok', evidence:['a'], extra:true }, { verdict:'GREEN',summary:'',evidence:['a'] }, { verdict:'RED',summary:'bad',evidence:[] }]) {
    const data=await fixture(t);
    await assert.rejects(createExecutorRegistry({streamFn:artifactStream({result})}).execute(data.request,data));
  }
  assert.throws(()=>validateResult({verdict:'GREEN',summary:'ok',evidence:['x'],extra:true}));
});

test('Agent timeout and external cancellation abort the actual Pi loop', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry({ streamFn: artifactStream({mode:'hang'}) });
  await assert.rejects(registry.execute({ ...data.request, profile: { ...data.request.profile, timeoutMs: 80 } }, data), /timed out/);
  const abort = new AbortController();
  const promise = registry.execute(data.request, { ...data, signal: abort.signal });
  setTimeout(() => abort.abort(), 80);
  await assert.rejects(promise, /aborted/);
});

test('code runner evaluates actual Node tests and distinguishes pass from assertion failure', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry();
  const request:ReviewEnvelope = { ...data.request, profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs'] } };
  await writeFile(join(data.worktreePath, 'tests/check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('count',()=>assert.equal(2,2));");
  assert.equal((await registry.execute(request, data)).verdict, 'GREEN');
  await writeFile(join(data.worktreePath, 'tests/check.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('count',()=>assert.equal(3,2));");
  const result = await registry.execute(request, data);
  assert.equal(result.verdict, 'RED'); assert.notEqual(result.exitCode, 0); assert.match(result.stdout!, /count/);
  assert.equal((await registry.canExecute({ profile: { kind: 'runtime', command: 'node', args: ['-e', 'process.exit()'] } })).ok, false);
});

test('Human uses registered notification and broker completion, independent of Pi auth', async t => {
  const data=await fixture(t);
  const request:ReviewRequest = { ...data.request, profile:{kind:'human'}, id:'human-1',runId:'run',status:'WAITING_HUMAN',createdAt:new Date().toISOString(),predecessorId:null,worktreePath:data.worktreePath,
    workspace:{version:1,mode:'copy',sourcePath:data.worktreePath,path:data.worktreePath,hash:data.request.snapshotHash,stateDir:join(data.dir,'state'),baselineMetadataHash:'b'.repeat(64)} };
  assert.equal((await createExecutorRegistry().canExecute(request)).ok, false);
  const received:string[] = [];
  const registry = createExecutorRegistry({ alarmMethods: [{ id: 'inbox', notify: async request => {received.push(request.id);} }] });
  assert.equal((await registry.canExecute(request)).ok, true);
  assert.deepEqual(await registry.notifyHuman(request), { alarmMethods: ['inbox'] });
  assert.deepEqual(received, ['human-1']);
  await assert.rejects(registry.execute(request, data), /claim\/result/);
  // @ts-expect-error Intentional malformed notification adapter at runtime boundary.
  assert.throws(() => createExecutorRegistry({ alarmMethods: ['email'] }), /alarm method/);
});

test('concurrent runtime reviews share input and use separate output/temp/home directories', async t => {
  const data = await fixture(t);
  await writeFile(join(data.worktreePath, 'tests/output.test.mjs'), `
import test from 'node:test';import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('isolated output',async()=>{assert.notEqual(process.cwd(),process.env.CCDD_OUTPUT_DIR);assert.equal(tmpdir(),process.env.CCDD_TMP_DIR);await writeFile(join(process.env.CCDD_OUTPUT_DIR,'result.json'),JSON.stringify({cwd:process.cwd(),output:process.env.CCDD_OUTPUT_DIR,temporary:tmpdir(),home:process.env.HOME}));await writeFile(join(tmpdir(),'temporary.txt'),'scratch');});`);
  const request:ReviewEnvelope = { ...data.request, profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/output.test.mjs'] } };
  const registry = createExecutorRegistry();
  const dirs = [join(data.dir, 'review-one'), join(data.dir, 'review-two')];
  const results = await Promise.all(dirs.map(runDir => registry.execute(request, { ...data, runDir })));
  assert.deepEqual(results.map(result => result.verdict), ['GREEN', 'GREEN']);
  const outputs = await Promise.all(dirs.map(async runDir => JSON.parse(await readFile(join(runDir, 'output/result.json'), 'utf8')) as Record<string,string>));
  assert.equal(outputs[0].cwd, outputs[1].cwd);
  for(const key of ['output','temporary','home']) assert.notEqual(outputs[0][key],outputs[1][key]);
  await assert.rejects(readFile(join(data.worktreePath, 'result.json')));
});

test('executors reject output inside input before creating files', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry({streamFn:artifactStream()});
  const requests:ReviewEnvelope[] = [data.request, { ...data.request, profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs'] } }];
  for (const request of requests) {
    const runDir = join(data.worktreePath, `should-not-exist-${request.profile.kind}`);
    await assert.rejects(registry.execute(request, { ...data, runDir }), /outside the review workspace/);
    await assert.rejects(access(runDir));
  }
});

test('Agent receives exact type descriptions and scope before operation guidance',async t=>{
  const data=await fixture(t);
  data.request.artifactTypes.markdown.agentTools={read:{description:'{artifactName}의 명세 텍스트를 줄 단위로 읽는다.'}};
  let inspected=false;
  const registry=createExecutorRegistry({streamFn:artifactStream({mode:'partial',onRequest:({context})=>{
    const tools=context.tools!;
    assert.equal(tools[1].description,'spec의 명세 텍스트를 줄 단위로 읽는다.');
    for(const tool of tools){
      const properties=(tool.parameters as unknown as {properties:Record<string,unknown>}).properties;
      assert.ok(properties.startLine);assert.ok(properties.lineCount);
      for(const name of ['offset','limit','path','tool'])assert.equal(properties[name],undefined);
    }
    const user=context.messages.find(x=>x.role==='user');
    const prompt=typeof user?.content==='string'?user.content:JSON.stringify(user?.content);
    assert.ok(prompt.indexOf('Artifacts:')<prompt.indexOf('Each tool is named'));
    assert.match(prompt,/spec의 명세 텍스트를 줄 단위로 읽는다/);inspected=true;
  }})});
  const result=await registry.execute(data.request,data);
  assert.equal(result.verdict,'GREEN');assert.ok(inspected);
  for(const call of result.toolCalls!){assert.equal(call.observation?.lineCount,1);assert.equal(call.observation?.startLine,2);assert.equal(call.observation?.endLine,2);}
});

test('directory listing alone cannot satisfy required source observation',async t=>{
  const data=await fixture(t);await writeFile(join(data.worktreePath,'tests/example.mjs'),'export const value=2;');
  data.request.artifacts=[{id:'tests',type:'code',path:'tests'}];
  await assert.rejects(createExecutorRegistry({streamFn:artifactStream({mode:'list-only'})}).execute(data.request,data),/did not inspect required artifact: tests/);
});
