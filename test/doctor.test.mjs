import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecutorRegistry } from '../src/executors/index.mjs';
import { diagnoseProject } from '../src/doctor/index.mjs';
import { git } from '../src/broker/config.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-doctor-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktreePath = join(dir, 'repo');
  await mkdir(join(worktreePath, 'tests'), { recursive: true });
  await writeFile(join(worktreePath, 'why.md'), 'Committed why.');
  await writeFile(join(worktreePath, 'spec.md'), 'Committed spec.');
  await writeFile(join(worktreePath, 'tests/check.test.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('SHOULD_NOT_RUN','bad'); throw new Error('doctor must not run this');");
  const profile = { kind: 'agent', provider: 'codex', model: 'test-model', reasoning: 'medium', timeoutMs: 3_000 };
  const config = {
    artifacts: { why: { type: 'markdown', path: 'why.md' }, spec: { type: 'markdown', path: 'spec.md' }, tests: { type: 'code', path: 'tests' } },
    artifactTypes: { markdown: { viewer: 'text' }, code: { viewer: 'files' } },
    critics: [
      { id: 'first', title: 'first', dependsOn: null, artifacts: ['why'], profile, payload: { instruction: 'Review why' } },
      { id: 'second', title: 'second', dependsOn: 'first', artifacts: ['spec'], profile: { timeoutMs: 3_000, reasoning: 'medium', model: 'test-model', provider: 'codex', kind: 'agent' }, payload: { instruction: 'Review spec' } },
      { id: 'runtime', title: 'runtime', dependsOn: 'second', artifacts: ['tests'], profile: { kind: 'runtime', command: 'node', args: ['--test', 'tests/check.test.mjs'] }, payload: { instruction: 'Run tests' } },
      { id: 'human', title: 'human', dependsOn: 'runtime', artifacts: ['spec'], profile: { kind: 'human' }, payload: { instruction: 'Human review' } },
    ],
  };
  await writeFile(join(worktreePath, 'ccdd.config.json'), JSON.stringify(config));
  await git(worktreePath, ['init', '-b', 'main']);
  await git(worktreePath, ['add', '.']);
  await git(worktreePath, ['-c', 'user.name=CCDD Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture']);
  const snapshotCommit = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
  const request = { id: 'doctor-test', criticId: 'first', snapshotCommit, profile, artifacts: [{ id: 'why', ...config.artifacts.why }], artifactTypes: config.artifactTypes };
  return { dir, worktreePath, repoPath: worktreePath, runDir: join(dir, 'run'), snapshotCommit, request, config };
}

async function fakeProvider(dir, mode = 'valid') {
  const path = join(dir, `fake-${mode}.mjs`);
  await writeFile(path, `#!${process.execPath}
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2), mode=${JSON.stringify(mode)};
const entries=args.filter((x,i)=>args[i-1]==='-c');
const value=key=>JSON.parse(entries.find(x=>x.startsWith(key+'=')).slice(key.length+1));
let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
await writeFile(${JSON.stringify(join(dir, 'probe-args.json'))},JSON.stringify({args,prompt}));
console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_REASONING_API_KEY_sk-secret'}}));
if(mode==='hang') {setInterval(()=>{},1000);await new Promise(()=>{});}
const errors={auth:'401 Unauthorized token expired sk-secret',model:'The model test-model is not supported',network:'error sending request: connection refused',unknown:'private error sk-secret'};
if(errors[mode]) {console.log(JSON.stringify({type:'turn.failed',error:{message:errors[mode]}}));process.exit(7);}
if(mode==='mcp'){console.error('ERROR MCP client ccdd_artifacts failed to initialize sk-secret');process.exit(7);}
const mcpArgs=value('mcp_servers.ccdd_artifacts.args');
const manifest=JSON.parse(await readFile(mcpArgs[1],'utf8'));
const artifact=manifest.artifacts.find(a=>a.id.startsWith('ccdd_probe_'));
let nonce='';
if(mode==='no-tools') nonce=(await readFile(manifest.worktreePath+'/'+artifact.path,'utf8')).trim();
else {
 const mcp=spawn(value('mcp_servers.ccdd_artifacts.command'),mcpArgs);
 const lines=createInterface({input:mcp.stdout});let sequence=0;const pending=new Map();
 lines.on('line',line=>{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id);});
 const call=(method,params)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
 await call('initialize',{protocolVersion:'2024-11-05'});
 const tools=(await call('tools/list')).result.tools;
 const tool=tools.find(tool=>tool.name==='read_'+artifact.id);
 const result=await call('tools/call',{name:tool.name,arguments:{}});
 nonce=JSON.parse(result.result.content[0].text).content.trim();
 mcp.stdin.end();
}
await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify({ready:true,nonce:mode==='wrong-nonce'?'wrong':nonce}));
`);
  await chmod(path, 0o700);
  return path;
}

test('Agent readiness requires a real subprocess MCP nonce roundtrip using the exact review profile', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry({ codexPath: await fakeProvider(data.dir) });
  const events = [];
  const result = await registry.probe(data.request, { ...data, onEvent: event => events.push(event) });
  assert.equal(result.ok, true);
  assert.equal(result.details.authenticationVerified, true);
  assert.equal(result.details.modelAccessVerified, true);
  assert.equal(result.details.artifactToolsVerified, true);
  assert.equal(result.details.toolCalls.length, 1);
  assert.match(result.details.toolCalls[0].name, /^read_ccdd_probe_/);
  assert.equal(result.verdict, undefined);
  assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_REASONING|sk-secret/);
  const { args, prompt } = JSON.parse(await readFile(join(data.dir, 'probe-args.json')));
  assert.equal(args[args.indexOf('--model') + 1], data.request.profile.model);
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  const final = JSON.parse(await readFile(join(data.runDir, 'provider-result.json')));
  assert.equal(prompt.includes(final.nonce), false);
  assert.equal((await readdir(data.worktreePath)).some(name => name.startsWith('.ccdd-doctor-')), false);
});

test('readiness identifies explicit auth, model, network and MCP errors without exposing raw provider output', async t => {
  const expected = { auth: 'AUTHENTICATION_FAILED', model: 'MODEL_ACCESS_FAILED', network: 'PROVIDER_CONNECTION_FAILED', mcp: 'MCP_UNAVAILABLE', unknown: 'PROVIDER_EXECUTION_FAILED' };
  for (const [mode, code] of Object.entries(expected)) {
    const data = await fixture(t);
    const registry = createExecutorRegistry({ codexPath: await fakeProvider(data.dir, mode) });
    await assert.rejects(registry.probe(data.request, data), error => {
      assert.equal(error.code, code);
      assert.ok(error.remedy);
      assert.doesNotMatch(error.message, /sk-secret|PRIVATE_REASONING/);
      return true;
    });
    assert.equal((await readdir(data.worktreePath)).some(name => name.startsWith('.ccdd-doctor-')), false);
  }
});

test('a fabricated nonce, unaudited response or hung provider cannot pass readiness', async t => {
  for (const mode of ['no-tools', 'wrong-nonce', 'hang']) {
    const data = await fixture(t);
    const registry = createExecutorRegistry({ codexPath: await fakeProvider(data.dir, mode) });
    const request = mode === 'hang' ? { ...data.request, profile: { ...data.request.profile, timeoutMs: 120 } } : data.request;
    await assert.rejects(registry.probe(request, data), error => error.code === (mode === 'hang' ? 'PROVIDER_TIMEOUT' : 'MCP_ROUNDTRIP_FAILED'));
    assert.equal((await readdir(data.worktreePath)).some(name => name.startsWith('.ccdd-doctor-')), false);
  }
});

test('runtime readiness starts Node and checks declared test paths without executing project tests', async t => {
  const data = await fixture(t);
  const registry = createExecutorRegistry();
  const request = { ...data.request, profile: data.config.critics[2].profile, artifacts: [{ id: 'tests', ...data.config.artifacts.tests }] };
  const result = await registry.probe(request, data);
  assert.equal(result.ok, true);
  assert.equal(result.details.testsExecuted, false);
  await assert.rejects(access(join(data.worktreePath, 'SHOULD_NOT_RUN')));
  await assert.rejects(registry.probe({ ...request, profile: { ...request.profile, args: ['--test', 'tests/missing.mjs'] } }, data), error => error.code === 'RUNTIME_TEST_PATH_UNAVAILABLE');
  await assert.rejects(registry.probe({ ...request, profile: { ...request.profile, args: ['--test', 'why.md'] } }, data), error => error.code === 'RUNTIME_TEST_PATH_OUTSIDE_ARTIFACTS');
});

test('Human readiness is explicitly registration-only and never sends a notification', async t => {
  const data = await fixture(t);
  const request = { ...data.request, profile: { kind: 'human' } };
  await assert.rejects(createExecutorRegistry().probe(request, data), error => error.code === 'HUMAN_ALARM_MISSING');
  let notified = false;
  const result = await createExecutorRegistry({ alarmMethods: [{ id: 'inbox', notify: () => { notified = true; } }] }).probe(request, data);
  assert.equal(result.ok, true);
  assert.equal(result.details.deliveryVerified, false);
  assert.equal(result.details.notificationsSent, false);
  assert.equal(notified, false);
});

test('project doctor diagnoses immutable snapshot, deduplicates full profiles and leaves no review state or worktree', async t => {
  const data = await fixture(t);
  await writeFile(join(data.repoPath, 'why.md'), 'Dirty mutable checkout must not be used');
  const probes = [];
  const events = [];
  const executors = { probe: async (request, options) => {
    probes.push(request);
    assert.equal((await git(options.worktreePath, ['rev-parse', 'HEAD'])).trim(), data.snapshotCommit);
    assert.equal(await readFile(join(options.worktreePath, 'why.md'), 'utf8'), 'Committed why.');
    return { ok: true, message: 'unit probe', details: { operation: 'unit-test-probe' } };
  } };
  const report = await diagnoseProject({ ...data, executors, onEvent: event => events.push(event) });
  assert.equal(report.status, 'READY');
  assert.deepEqual(report.scope, { kind: 'chain' });
  assert.equal(probes.length, 3);
  assert.deepEqual(report.checks.find(check => check.kind === 'agent').criticIds, ['first', 'second']);
  assert.equal(events.filter(event => event.type === 'doctor.check').length, report.checks.length);
  assert.equal((await git(data.repoPath, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
  assert.equal(await readFile(join(data.repoPath, 'why.md'), 'utf8'), 'Dirty mutable checkout must not be used');
  assert.equal((await readdir(data.repoPath)).includes('.ccdd'), false);
  assert.equal(JSON.stringify(report).includes('verdict'), false);
});

test('selected doctor scope probes only that Critic and returns actionable NOT_READY failures', async t => {
  const data = await fixture(t);
  const probes = [];
  const report = await diagnoseProject({ ...data, criticId: 'second', executors: { probe: async request => { probes.push(request.criticId); throw Object.assign(new Error('Authentication required'), { code: 'AUTHENTICATION_FAILED', remedy: 'Login again' }); } } });
  assert.equal(report.status, 'NOT_READY');
  assert.deepEqual(report.scope, { kind: 'critic', criticId: 'second' });
  assert.deepEqual(probes, ['second']);
  assert.equal(report.checks.at(-1).details.code, 'AUTHENTICATION_FAILED');
  const missing = await diagnoseProject({ ...data, criticId: 'unknown', executors: { probe: () => { throw new Error('must not probe'); } } });
  assert.equal(missing.ok, false);
  assert.match(missing.checks[0].message, /Unknown Critic/);
});

test('project doctor fails missing binaries and unsupported providers before attempting authentication', async t => {
  const data = await fixture(t);
  const report = await diagnoseProject({ ...data, criticId: 'first', executors: createExecutorRegistry({ codexPath: '/does/not/exist/codex' }) });
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.checks.at(-1).details.code, 'PROVIDER_NOT_EXECUTABLE');
  await assert.rejects(createExecutorRegistry().probe({ ...data.request, profile: { ...data.request.profile, provider: 'unregistered' } }, data), error => error.code === 'PROVIDER_NOT_REGISTERED');
});

test('identical runtime commands are checked for each Critic artifact scope', async t => {
  const data = await fixture(t);
  const profile = data.config.critics[2].profile;
  data.config.critics = [
    { ...data.config.critics[0], profile, artifacts: ['tests'] },
    { ...data.config.critics[1], profile, artifacts: ['why'] },
  ];
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await git(data.repoPath, ['add', 'ccdd.config.json']);
  await git(data.repoPath, ['-c', 'user.name=CCDD Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'runtime scopes']);
  const snapshotCommit = (await git(data.repoPath, ['rev-parse', 'HEAD'])).trim();
  const report = await diagnoseProject({ ...data, snapshotCommit, executors: createExecutorRegistry() });
  const runtimeChecks = report.checks.filter(check => check.kind === 'runtime');
  assert.equal(runtimeChecks.length, 2);
  assert.equal(runtimeChecks[0].status, 'PASS');
  assert.equal(runtimeChecks[1].status, 'FAIL');
  assert.equal(runtimeChecks[1].details.code, 'RUNTIME_TEST_PATH_OUTSIDE_ARTIFACTS');
});

test('doctor checks the complete Agent profile and rejects changed worktree HEAD', async t => {
  const data = await fixture(t);
  data.config.critics[1].profile.timeoutMs = 2_500;
  await writeFile(join(data.repoPath, 'ccdd.config.json'), JSON.stringify(data.config));
  await git(data.repoPath, ['add', 'ccdd.config.json']);
  await git(data.repoPath, ['-c', 'user.name=CCDD Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'different timeout']);
  const snapshotCommit = (await git(data.repoPath, ['rev-parse', 'HEAD'])).trim();
  const probes = [];
  const report = await diagnoseProject({ ...data, snapshotCommit, executors: { probe: async (request, options) => {
    probes.push(request.criticId);
    if (request.criticId === 'human') await git(options.worktreePath, ['checkout', '--detach', data.snapshotCommit]);
    return { ok: true, message: 'unit-test probe' };
  } } });
  assert.equal(probes.length, 4);
  assert.equal(report.status, 'NOT_READY');
  assert.equal(report.checks.at(-1).details.code, 'SNAPSHOT_CHANGED');
  assert.equal((await git(data.repoPath, ['worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
});
