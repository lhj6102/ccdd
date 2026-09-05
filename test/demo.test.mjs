import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareDemo} from '../scripts/prepare-demo.mjs';

test('four editable workspaces preserve the graph and real runtime regression without Git',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ccdd-demo-test-'));
  try{
    const manifest=await prepareDemo({root});assert.equal(manifest.scenarios.length,4);
    assert.deepEqual(await prepareDemo({root}),manifest);
    for(const scenario of manifest.scenarios){
      const read=p=>readFile(join(scenario.repoPath,p),'utf8');
      const config=JSON.parse(await read('ccdd.config.json'));
      assert.deepEqual(config.critics.map(c=>c.dependsOn),[null,'spec-why','tests-spec']);
      await assert.rejects(access(join(scenario.repoPath,'.git')));
      if(scenario.id==='why-change'){assert.match(await read('why.md'),/최대 2개/);assert.match(await read('spec.md'),/최대 3개/);}
      const {NODE_TEST_CONTEXT,...childEnv}=process.env;
      const run=spawnSync(process.execPath,['--test','tests/rank.test.mjs'],{cwd:scenario.repoPath,encoding:'utf8',env:childEnv});
      assert.equal(run.status,scenario.id==='runtime-failure'?1:0,run.stdout+run.stderr);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
