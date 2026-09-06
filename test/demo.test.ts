import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareDemo} from '../scripts/prepare-demo.js';
import {readWorkspaceConfig} from '../src/broker/config.js';
import type { RepoConfig } from '../src/contracts.js';

test('monitor fixture keeps semantic reviews as Agent Critics alongside Human and Runtime',async()=>{
  const {config}=await readWorkspaceConfig(fileURLToPath(new URL('../../test/fixtures/monitor-graph/',import.meta.url)));
  const critics=new Map(config.critics.map(critic=>[critic.id,critic]));
  for(const id of ['spec-why','tests-spec'])assert.deepEqual(critics.get(id)?.profile,{kind:'agent',provider:'openai-codex',model:'gpt-6-astra',reasoning:'medium'});
  assert.equal(critics.get('spec-human')?.profile.kind,'human');
  assert.equal(critics.get('notes-independent')?.profile.kind,'runtime');
  assert.deepEqual(critics.get('implementation-tests')?.profile,{kind:'runtime',command:'node',args:['--test','tests/focus.test.mjs']});
  assert.deepEqual(config.critics.filter(critic=>critic.target==='spec').map(critic=>critic.id).sort(),['spec-human','spec-why']);
  assert.deepEqual(critics.get('tests-spec')?.deps,['spec']);
});

test('four editable workspaces preserve the graph and real runtime regression without Git',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ccdd-demo-test-'));
  try{
    const manifest=await prepareDemo({root});assert.equal(manifest.scenarios.length,4);assert.equal(manifest.version,8);
    assert.deepEqual(await prepareDemo({root}),manifest);
    for(const scenario of manifest.scenarios){
      const read=(p:string)=>readFile(join(scenario.repoPath,p),'utf8');
      const config=JSON.parse(await read('ccdd.config.json')) as RepoConfig;
      assert.deepEqual(config.critics.map(c=>[c.target,c.deps]),[['spec',['why']],['tests',['spec']],['implementation',['tests']]]);assert.equal(config.artifacts.why.basis,true);
      assert.deepEqual(config.critics.slice(0,2).map(c=>c.profile),Array(2).fill({kind:'agent',provider:'openai-codex',model:'gpt-6-astra',reasoning:'medium'}));
      assert.equal(config.artifactTypes.markdown.agentTools!.read!.description,'{artifactName}의 문서 내용을 줄 단위로 읽는다.');
      assert.equal(config.artifactTypes.code.agentTools!.list!.description,'{artifactName}의 파일 목록을 조회한다.');
      assert.equal(config.artifactTypes.code.agentTools!.read!.description,'{artifactName}의 소스 텍스트를 줄 단위로 읽는다.');
      assert.ok(config.artifactTypes.markdown.humanTools!.read);
      await assert.rejects(access(join(scenario.repoPath,'.git')));
      if(scenario.id==='why-change'){assert.match(await read('why.md'),/최대 2개/);assert.match(await read('spec.md'),/최대 3개/);}
      const {NODE_TEST_CONTEXT,...childEnv}=process.env;
      const run=spawnSync(process.execPath,['--test','tests/rank.test.mjs'],{cwd:scenario.repoPath,encoding:'utf8',env:childEnv});
      assert.equal(run.status,scenario.id==='runtime-failure'?1:0,run.stdout+run.stderr);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('preparing a demo preserves edited current files and rejects an older manifest without rewriting it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ccdd-demo-preserve-'));
  try{
    const manifest=await prepareDemo({root});
    const configPath=join(manifest.scenarios[0].repoPath,'ccdd.config.json');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    config.artifactTypes.markdown.agentTools!.read!.description='{artifactName}의 사용자 지정 설명';
    config.critics[0].profile.model='gpt-5.6-sol';
    const edited=JSON.stringify(config);
    await writeFile(configPath,edited);
    assert.deepEqual(await prepareDemo({root}),manifest);
    assert.equal(await readFile(configPath,'utf8'),edited);
    const previous=JSON.stringify({...manifest,version:3});
    await writeFile(join(root,'manifest.json'),previous);
    await assert.rejects(prepareDemo({root}),/preserve/);
    assert.equal(await readFile(join(root,'manifest.json'),'utf8'),previous);
    assert.equal(await readFile(configPath,'utf8'),edited);
  }finally{await rm(root,{recursive:true,force:true});}
});
