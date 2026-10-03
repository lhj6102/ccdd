import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { artifactFixture } from './helpers/artifacts.js';
import { openProviderCoordinator, providerLane, providerStatus, resumeProvider } from '../src/executors/provider-coordinator.js';

test('Provider cooldown and account suspension are shared across connections without storing credentials', async t => {
  const {root}=await artifactFixture(t), file=join(root,'providers.sqlite'), secret='not-a-real-token-private', lane=providerLane('controlled',secret);
  const a=openProviderCoordinator('controlled',lane,file),b=openProviderCoordinator('controlled',lane,file),other=openProviderCoordinator('controlled',providerLane('controlled','other'),file);
  t.after(()=>{a.close();b.close();other.close();});
  await a.defer(150); const start=performance.now();
  await other.wait(new AbortController().signal,start+5000);
  await b.wait(new AbortController().signal,start+5000); assert.ok(performance.now()-start>=100);
  await a.block('QUOTA_EXHAUSTED');
  await assert.rejects(b.wait(new AbortController().signal,performance.now()+5000),{code:'QUOTA_EXHAUSTED'});
  await other.wait(new AbortController().signal,performance.now()+5000);
  assert.equal(providerStatus(file)[0].blocked,'QUOTA_EXHAUSTED');
  assert.equal(resumeProvider('controlled',file),1);
  await b.wait(new AbortController().signal,performance.now()+5000);
  assert.ok(!(await readFile(file)).includes(Buffer.from(secret)));
});

test('Provider waiting honors cancellation and a monotonic review deadline', async t => {
  const {root}=await artifactFixture(t),c=openProviderCoordinator('controlled','lane',join(root,'providers.sqlite'));
  t.after(()=>c.close());await c.defer(3000);
  await assert.rejects(c.wait(new AbortController().signal,performance.now()+10),{code:'PROVIDER_TIMEOUT'});
  const abort=new AbortController();const waiting=c.wait(abort.signal,performance.now()+5000);abort.abort();await assert.rejects(waiting,{name:'AbortError'});
});
