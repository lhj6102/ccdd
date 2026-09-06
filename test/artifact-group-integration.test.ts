import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker } from '../src/broker/index.js';
import { projectGraph } from '../src/broker/graph.js';
import { prepareReviewRequests } from '../src/requester/index.js';
import { createReviewTools } from '../src/tools/runner.js';
import { createExecutorRegistry } from '../src/executors/index.js';
import { diagnoseArtifactTools } from '../src/artifacts/tool-check.js';
import { diagnoseProject } from '../src/doctor/index.js';
import { artifactInstructionMembers, digestArtifactInstruction } from '../src/artifacts/instruction.js';
import { removeOwnedWorkspaceTree } from '../src/workspaces/index.js';
import { artifactStream } from './pi-fixture.js';
import type { StreamFn } from '../src/executors/pi.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ccdd-group-integration-'));
  t.after(() => removeOwnedWorkspaceTree(dir));
  const repoPath = join(dir, 'repo');
  await mkdir(repoPath);
  for (const id of ['effect', 'preview', 'brief', 'delivery']) await writeFile(join(repoPath, `${id}.md`), `# ${id}\nActual ${id} content.\n`);
  const launched = join(dir, 'opened');
  const configPath = join(repoPath, 'ccdd.config.ts');
  const source = `import { readFile, writeFile } from 'node:fs/promises';
const read = {
  metadata: { description: 'Read {artifactName}.', inputSchema: { type: 'object', properties: { startLine: {type:'integer'}, lineCount: {type:'integer'} }, additionalProperties: false }, resultKinds: ['text'], observation: 'content' },
  preflight: () => ({ok:true,message:'Ready without executing.'}),
  async execute(context) { return {content:[{type:'text',text:await readFile(await context.resolvePath(),'utf8')}],observation:{kind:'content'}}; }
};
const open = {
  metadata: { description: 'Open {artifactName}.', inputSchema: {type:'object',additionalProperties:false}, resultKinds:['launch'], observation:'none' },
  preflight: () => ({ok:true,message:'Ready without launching.'}),
  async execute(context) { await writeFile(${JSON.stringify(launched)}, context.artifactPath); return {content:[{type:'launch',launched:true}]}; }
};
export default {
 artifacts: {
  brief: {type:'text',path:'brief.md',basis:true},
  effect: {type:'text',path:'effect.md'}, preview: {type:'text',path:'preview.md'},
  pair: {kind:'group',members:['effect','preview']},
  explosion: {kind:'group',members:['pair','preview']},
  delivery: {type:'text',path:'delivery.md'}
 },
 artifactTypes: {text:{agentTools:{read},humanTools:{open}}},
 critics: [
  {id:'preview-review',title:'Preview review',target:'preview',deps:['brief'],profile:{kind:'human'},payload:{instruction:'Inspect {preview} against {brief}.'}},
  {id:'agent-review',title:'Group Agent review',target:'explosion',deps:['preview'],profile:{kind:'agent',provider:'openai-codex',model:'gpt-6-astra',reasoning:'medium'},payload:{instruction:'Inspect {explosion} and {preview}. {brief} is outside this request.'}},
  {id:'group-review',title:'Group Human review',target:'explosion',deps:['preview'],profile:{kind:'human'},payload:{instruction:'Inspect {explosion}.'}},
  {id:'delivery-review',title:'Delivery',target:'delivery',deps:['explosion'],profile:{kind:'human'},payload:{instruction:'Use {explosion} to review {delivery}.'}}
 ]
};`;
  await writeFile(configPath, source);
  return { dir, repoPath, configPath, source, launched, worktreePath: repoPath, runDir: join(dir, 'outputs'), stateDir: join(dir, 'state') };
}

const requestOptions = (data: Awaited<ReturnType<typeof fixture>>) => ({ repoPath: data.repoPath, repoId: 'group-test', snapshotHash: 'a'.repeat(64), criticId: 'agent-review' });

test('group requests grant deduplicated leaves, preserve member identity, and never follow member Critic deps', async t => {
  const data = await fixture(t);
  const [request] = await prepareReviewRequests(requestOptions(data));
  assert.deepEqual(request.artifacts.map(a => a.id), ['effect', 'preview']);
  assert.deepEqual(request.artifactGroups, [{id:'explosion',members:['pair','preview']},{id:'pair',members:['effect','preview']}]);
  assert.equal(request.target, 'explosion');
  assert.deepEqual(request.deps, ['preview']);
  const options = {...request, worktreePath:data.repoPath, audience:'agent' as const, runDir:data.runDir};
  const registry = await createReviewTools(options);
  try {
    assert.deepEqual(registry.tools.map(tool => tool.name), ['read_effect','read_preview']);
    await assert.rejects(registry.call('read_brief'), /Unknown registered/);
    await registry.call('read_preview');
    assert.deepEqual(registry.toolCalls.map(call => call.observation?.artifactId), ['preview']);
  } finally { await registry.close(); }
  for (const change of [
    {artifactGroups: undefined},
    {artifactGroups: [{id:'explosion',members:['effect']}]},
    {artifacts: [request.artifacts[1]]},
    {artifacts: [...request.artifacts,{id:'brief',path:'brief.md',type:'text'}]},
  ]) await assert.rejects(createReviewTools({...options,...change}), {code:'WORKSPACE_ARTIFACT_MISMATCH'});
});

test('group digest maps actual member tools, keeps nested composition and out-of-scope references safe', async t => {
  const data = await fixture(t);
  const [request] = await prepareReviewRequests(requestOptions(data));
  const tools = [{artifactId:'effect',name:'inspect_effect'},{artifactId:'preview',name:'view_image_preview'},{artifactId:'brief',name:'read_brief'}];
  const value = digestArtifactInstruction('{explosion} / {preview} / {brief}', request.artifacts, tools, request.artifactGroups);
  assert.equal(value, '{"artifactGroup":"explosion","members":[{"artifact":"effect","tools":["inspect_effect"]},{"artifact":"preview","tools":["view_image_preview"]}]} / {"artifact":"preview","tools":["view_image_preview"]} / {brief}');
  assert.deepEqual(artifactInstructionMembers('explosion', request.artifacts, request.artifactGroups), ['effect','preview']);
  assert.deepEqual(artifactInstructionMembers('loop',request.artifacts,[{id:'loop',members:['loop','preview','brief']}]),['preview']);
});

test('Pi Agent reviews each group leaf and cannot satisfy a group by inspecting only one member', async t => {
  const data = await fixture(t);
  const [request] = await prepareReviewRequests(requestOptions(data));
  let checked = false;
  const result = await createExecutorRegistry({streamFn:artifactStream({onRequest({context}) {
    const prompt = JSON.stringify(context.messages);
    if (!checked) {
      assert.match(prompt, /artifactGroup/); assert.match(prompt, /explosion/);
      assert.deepEqual(context.tools?.map(tool=>tool.name), ['read_effect','read_preview']);
      checked = true;
    }
  }})}).execute(request,data);
  assert.equal(result.verdict,'GREEN');
  assert.deepEqual(result.toolCalls?.map(call=>call.observation?.artifactId),['effect','preview']);
  const partial = artifactStream();
  const streamFn: StreamFn = (model,context,options) => partial(model,{...context,tools:context.tools?.filter(tool=>tool.name==='read_effect')},options);
  await assert.rejects(createExecutorRegistry({streamFn}).execute(request,data),/did not inspect required artifact: preview/);
});

test('group admission requires usable audience tools on every leaf, even shared members', async t => {
  const data = await fixture(t);
  await writeFile(data.configPath,data.source.replace("preview: {type:'text'", "preview: {type:'hidden'").replace('artifactTypes: {text:', 'artifactTypes: {hidden:{humanTools:{open}},text:'));
  await assert.rejects(prepareReviewRequests(requestOptions(data)),/preview has no usable agent tools/);
});

test('group tools check and doctor preflight leaf tools without launching; execution selects a leaf', async t => {
  const data = await fixture(t);
  const report = await diagnoseArtifactTools({...data,artifactId:'explosion',audience:'human'});
  assert.equal(report.ok,true,JSON.stringify(report));
  assert.deepEqual(report.tools.map(tool=>tool.name),['open_effect','open_preview']);
  await assert.rejects(readFile(data.launched),{code:'ENOENT'});
  const group = await diagnoseArtifactTools({...data,artifactId:'explosion',audience:'human',toolName:'open',execute:true});
  assert.equal(group.ok,false); assert.match(group.checks[0].message,/Select a leaf/);
  const doctor = await diagnoseProject({...data,criticId:'group-review',executors:createExecutorRegistry({alarmMethods:[{id:'test',notify(){throw new Error('Do not notify in doctor');}}]})});
  assert.equal(doctor.ok,true,JSON.stringify(doctor));
  await assert.rejects(readFile(data.launched),{code:'ENOENT'});
  const leaf = await diagnoseArtifactTools({...data,artifactId:'preview',audience:'human',toolName:'open',execute:true});
  assert.equal(leaf.ok,true,JSON.stringify(leaf));
  assert.equal(await readFile(data.launched,'utf8'),join(leaf.workspacePath!,'preview.md'));
});

test('copy Human group claim and tools survive restart; group verdict gates only explicit downstream deps', async t => {
  const data = await fixture(t);
  const executors = createExecutorRegistry({streamFn:artifactStream(),alarmMethods:[{id:'test',notify(){}}]});
  let broker = createBroker({...data,executors});
  t.after(()=>broker.close());
  const submitted = await broker.submit({mode:'copy',requesterId:'group-test'});
  const first = await broker.run(submitted.id);
  assert.equal(first!.requests.find(r=>r.criticId==='preview-review')?.status,'WAITING_HUMAN');
  assert.equal(first!.requests.find(r=>r.criticId==='group-review')?.status,'BLOCKED');
  const preview = first!.requests.find(r=>r.criticId==='preview-review')!;
  broker.claimHuman(preview.id,'reviewer');
  await broker.completeHuman(preview.id,{reviewerId:'reviewer',result:{verdict:'GREEN',summary:'Preview reviewed',evidence:['Preview matches brief.']}});
  const next = await broker.run(submitted.id);
  const group = next!.requests.find(r=>r.criticId==='group-review')!;
  assert.equal(group.status,'WAITING_HUMAN');
  assert.equal(next!.requests.find(r=>r.criticId==='agent-review')?.status,'GREEN');
  assert.equal(next!.requests.find(r=>r.criticId==='delivery-review')?.status,'BLOCKED');
  await broker.close();
  broker = createBroker({...data,executors});
  broker.claimHuman(group.id,'reviewer');
  await broker.executeHumanTool(group.id,{reviewerId:'reviewer',toolName:'open_effect'});
  assert.equal(await readFile(data.launched,'utf8'),join(group.workspace.path,'effect.md'));
  await broker.completeHuman(group.id,{reviewerId:'reviewer',result:{verdict:'GREEN',summary:'Group reviewed',evidence:['Effect and preview agree.']}});
  const last = await broker.run(submitted.id);
  assert.equal(last!.requests.find(r=>r.criticId==='delivery-review')?.status,'WAITING_HUMAN');
  const graph = projectGraph(last!.graph!,last!.requests);
  assert.equal(graph.artifacts.find(a=>a.id==='explosion')?.status,'GREEN');
  assert.equal(graph.artifacts.find(a=>a.id==='effect')?.status,'UNREVIEWED');
  assert.equal(graph.artifacts.find(a=>a.id==='pair')?.status,'UNREVIEWED');
  assert.equal(graph.artifacts.find(a=>a.id==='preview')?.status,'GREEN');
});
