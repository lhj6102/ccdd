import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareDemo} from '../scripts/prepare-demo.mjs';

test('four real snapshots preserve linear graph and expose actual runtime regression',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ccdd-demo-test-'));
  try{
    const manifest=await prepareDemo({root});assert.equal(manifest.scenarios.length,4);
    for(const scenario of manifest.scenarios){
      const read=p=>spawnSync('git',['show',`${scenario.commit}:${p}`],{cwd:manifest.repoPath,encoding:'utf8'}).stdout;
      const config=JSON.parse(read('ccdd.config.json'));
      assert.deepEqual(config.critics.map(c=>c.dependsOn),[null,'spec-why','tests-spec']);
      assert.equal(config.critics[2].profile.kind,'runtime');
      if(scenario.id==='why-change'){assert.match(read('why.md'),/최대 2개/);assert.match(read('spec.md'),/최대 3개/);}
      const wt=join(root,`wt-${scenario.id}`);assert.equal(spawnSync('git',['worktree','add','--detach',wt,scenario.commit],{cwd:manifest.repoPath}).status,0);
      const {NODE_TEST_CONTEXT,...childEnv}=process.env;
      const run=spawnSync(process.execPath,['--test','tests/rank.test.mjs'],{cwd:wt,encoding:'utf8',env:childEnv});
      assert.equal(run.status,scenario.id==='runtime-failure'?1:0,run.stdout+run.stderr);
      spawnSync('git',['worktree','remove','--force',wt],{cwd:manifest.repoPath});
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
