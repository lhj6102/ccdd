import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,rm,readFile,writeFile,access,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareDemo, type DemoDependencyInstaller} from '../scripts/prepare-demo.js';
import {readWorkspaceConfig} from '../src/broker/config.js';



/** Avoid network in scenario tests while using the actual built SDK/default library modules. */
const installFixtureDependencies:DemoDependencyInstaller=async({stagePath})=>{
  const core=join(stagePath,'node_modules/@ccdd/core');
  const tools=join(stagePath,'node_modules/@ccdd/default-tools');
  await mkdir(core,{recursive:true}); await mkdir(tools,{recursive:true});
  await cp(fileURLToPath(new URL('../src/sdk.js',import.meta.url)),join(core,'sdk.js'));
  const {version}=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  await writeFile(join(core,'package.json'),JSON.stringify({name:'@ccdd/core',version,type:'module',exports:'./sdk.js'}));
  const toolsDist=dirname(fileURLToPath(import.meta.resolve('@ccdd/default-tools')));
  await cp(toolsDist,join(tools,'dist'),{recursive:true});
  await cp(join(toolsDist,'../package.json'),join(tools,'package.json'));
  await writeFile(join(stagePath,'package-lock.json'),JSON.stringify({name:'ccdd-focus-demo',lockfileVersion:3,packages:{}}));
};
async function demoOptions(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'ccdd-demo-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const coreTarball=join(dir,'core.tgz'),toolsTarball=join(dir,'tools.tgz');
  await writeFile(coreTarball,'fixture-package-input');await writeFile(toolsTarball,'fixture-package-input');
  return {root:join(dir,'demo'),coreTarball,toolsTarball,installDependencies:installFixtureDependencies};
}

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

test('four editable workspaces preserve the graph and real runtime regression without Git',async t=>{
  const options=await demoOptions(t), {root}=options;
  try{
    const manifest=await prepareDemo(options);assert.equal(manifest.scenarios.length,4);assert.equal(manifest.version,9);
    assert.deepEqual(await prepareDemo({root}),manifest);
    for(const scenario of manifest.scenarios){
      const read=(p:string)=>readFile(join(scenario.repoPath,p),'utf8');
      const {config}=await readWorkspaceConfig(scenario.repoPath);
      await assert.rejects(access(join(scenario.repoPath,'ccdd.config.json')));
      assert.deepEqual(config.critics.map(c=>[c.target,c.deps]),[['spec',['why']],['tests',['spec']],['implementation',['tests']]]);assert.equal(config.artifacts.why.basis,true);
      assert.deepEqual(config.critics.slice(0,2).map(c=>c.profile),Array(2).fill({kind:'agent',provider:'openai-codex',model:'gpt-6-astra',reasoning:'medium'}));
      assert.equal(config.configManifest!.types.markdown.agentTools.read.description,'Read document content from {artifactName} by line.');
      assert.equal(config.configManifest!.types.code.agentTools.list.description,'List files in {artifactName}.');
      assert.equal(config.configManifest!.types.code.agentTools.read.description,'Read source text from {artifactName} by line.');
      assert.deepEqual(Object.keys(config.configManifest!.types.markdown.humanTools),['open']);
      assert.deepEqual(config.configManifest!.types.markdown.humanTools.open.resultKinds,['launch']);
      await assert.rejects(access(join(scenario.repoPath,'.git')));
      if(scenario.id==='why-change'){assert.match(await read('why.md'),/at most 2/);assert.match(await read('spec.md'),/at most 3/);}
      const {NODE_TEST_CONTEXT,...childEnv}=process.env;
      const run=spawnSync(process.execPath,['--test','tests/rank.test.mjs'],{cwd:scenario.repoPath,encoding:'utf8',env:childEnv});
      assert.equal(run.status,scenario.id==='runtime-failure'?1:0,run.stdout+run.stderr);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('preparing a demo preserves edited current files and rejects an older manifest without rewriting it',async t=>{
  const options=await demoOptions(t), {root}=options;
  try{
    const manifest=await prepareDemo(options);
    const configPath=join(manifest.scenarios[0].repoPath,'ccdd.config.ts');
    const edited=(await readFile(configPath,'utf8')).replaceAll('gpt-6-astra','gpt-5.6-sol').replace('Read document content','Custom description');
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


test('a new demo requires both package inputs before creating any directory',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ccdd-demo-inputs-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=join(dir,'demo');
  await assert.rejects(prepareDemo({root,coreTarball:'',toolsTarball:''}),/CCDD_DEMO_CORE_TARBALL/);
  await assert.rejects(access(root),{code:'ENOENT'});
  await assert.rejects(prepareDemo({root,coreTarball:join(dir,'missing.tgz'),toolsTarball:join(dir,'also-missing.tgz')}),/existing regular files/);
  assert.deepEqual(await readdir(dir),[]);
});

test('saved demos using the previous npm namespace are reused without rewriting their config', async t => {
  const options = await demoOptions(t), manifest = await prepareDemo(options);
  const saved: string[] = [];
  for (const scenario of manifest.scenarios) {
    const configPath = join(scenario.repoPath, 'ccdd.config.ts');
    const config = (await readFile(configPath, 'utf8')).replaceAll('@ccdd/core', '@lhj6102/ccdd').replaceAll('@ccdd/default-tools', '@lhj6102/ccdd-default-tools');
    await writeFile(configPath, config); saved.push(config);
    await mkdir(join(scenario.repoPath, 'node_modules/@lhj6102'), { recursive: true });
    await rename(join(scenario.repoPath, 'node_modules/@ccdd/core'), join(scenario.repoPath, 'node_modules/@lhj6102/ccdd'));
    await rename(join(scenario.repoPath, 'node_modules/@ccdd/default-tools'), join(scenario.repoPath, 'node_modules/@lhj6102/ccdd-default-tools'));
  }
  assert.deepEqual(await prepareDemo({ root: options.root }), manifest);
  for (const [index, scenario] of manifest.scenarios.entries()) assert.equal(await readFile(join(scenario.repoPath, 'ccdd.config.ts'), 'utf8'), saved[index]);
});
