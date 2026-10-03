// Reproducible offline scale acceptance. Never invokes a live Provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp, { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import fs, { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createBroker, inspectProject, loadCheck } from '../dist/src/project/index.js';
import { openResources, resourcePaths } from '../dist/src/resources.js';

if (process.argv[2] === '--plan-worker') {
  const result = await inspectProject({ repoPath: process.argv[3], stateDir: process.argv[4], selection: { kind: 'all' } });
  process.stdout.write(JSON.stringify({ count: result.plan.items.length, ...result.plan.counts }));
} else {
  const root = await mkdtemp(join(tmpdir(), 'ccdd-local-compute-acceptance-'));
  const previous = { CCDD_STATE_HOME: process.env.CCDD_STATE_HOME, CCDD_CONFIG_HOME: process.env.CCDD_CONFIG_HOME };
  process.env.CCDD_STATE_HOME = join(root, 'machine');
  process.env.CCDD_CONFIG_HOME = join(root, 'config');
  await mkdir(process.env.CCDD_CONFIG_HOME);
  await writeFile(resourcePaths().config, JSON.stringify({ identityCapacity: 100, defaultProviderCapacity: 4 }));
  const children = new Set();
  const reports = {};
  const runPlanner = (repoPath, stateDir) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--plan-worker', repoPath, stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.stdout.on('data', bytes => { out = (out + bytes).slice(-65536); });
    child.stderr.on('data', bytes => { err = (err + bytes).slice(-4096); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer); children.delete(child);
      if (code !== 0) { reject(new Error(`Planner failed (${code ?? signal}): ${err}`)); return; }
      try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
    });
  });
  try {
    // Two independent processes and repositories contend on the same resource DB.
    const catalogs = [];
    for (const name of ['alpha', 'beta']) {
      const repoPath = join(root, name), folder = join(repoPath, 'family');
      await mkdir(folder, { recursive: true });
      const instances = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [`item-${i}`, {}]));
      await writeFile(join(folder, 'ccdd.json'), JSON.stringify({ name: 'catalog', family: { instances },
        stale: { kind: 'identity', script: { command: 'node', args: ['identity.mjs'] } },
        critics: [{ id: 'review', title: 'Offline plan only', profile: { kind: 'human' }, payload: { instruction: 'Plan without executing a review.' } }] }));
      await writeFile(join(folder, 'identity.mjs'), "let text='';for await(const chunk of process.stdin)text+=chunk;console.log(JSON.parse(text).artifactId);\n");
      catalogs.push([repoPath, join(root, `${name}-state`)]);
    }
    const resources = openResources();
    const database = new DatabaseSync(resourcePaths().database, { readOnly: true, timeout: 5000 });
    let peakWeight = 0;
    const observe = () => { const row = database.prepare("SELECT COALESCE(SUM(weight),0) AS weight FROM resource_leases WHERE lane='identity' AND state='active'").get(); peakWeight = Math.max(peakWeight, Number(row.weight)); };
    const monitor = setInterval(observe, 20), started = performance.now();
    try {
      const plans = await Promise.all(catalogs.map(args => runPlanner(...args)));
      for (const plan of plans) { assert.equal(plan.count, 180); assert.equal(plan.execute, 180); }
      observe();
      assert.ok(peakWeight > 0 && peakWeight <= 100, `Unexpected machine identity utilization: ${peakWeight}`);
      assert.equal(Number(database.prepare('SELECT COUNT(*) AS n FROM resource_leases').get().n), 0);
      reports.contention = { processes: 2, identitiesPerProcess: 180, peakWeight, elapsedMs: performance.now() - started };
      console.error(JSON.stringify({ phase: 'contention', ...reports.contention }));
    } finally { clearInterval(monitor); database.close(); resources.close(); }

    // Every scenario entry is selected: this is not only an oversized unused argv fixture.
    const repoPath = join(root, 'large'), folder = join(repoPath, 'family');
    await mkdir(folder, { recursive: true });
    const ids = Array.from({ length: 1101 }, (_, i) => `item-${i}`);
    const definition = { name: 'large-catalog', family: { instances: Object.fromEntries(ids.map(id => [id, {}])) },
      views: { agentTools: { observe: { metadata: { description: 'Observe offline data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text'], observation: 'content' }, script: { command: 'node', args: ['observe.mjs'] } } } },
      critics: [{ id: 'review', title: 'Offline diagnostic only', profile: { kind: 'agent', provider: '$offline', model: 'synthetic', reasoning: 'none' }, payload: { instruction: 'Exercise registered tools; this is not Provider evidence.' }, passSchema: { type: 'object', properties: { diagnostic: { type: 'string' } }, required: ['diagnostic'], additionalProperties: false } }] };
    const manifest = JSON.stringify(definition);
    await writeFile(join(folder, 'ccdd.json'), manifest);
    await writeFile(join(folder, 'observe.mjs'), "if(Reflect.get(globalThis,Symbol.for('ccdd.offline-guard'))!==true)throw Error('missing guard');for await(const chunk of process.stdin){};console.log(JSON.stringify({content:[{type:'text',text:'offline'}],observation:{kind:'content'}}));\n");
    const scenario = { steps: [{ operation: 'observe' }], criticResults: Object.fromEntries(ids.map(id => [`${id}/review`, { verdict: 'GREEN', diagnostic: 'x'.repeat(160) }])) };
    const scenarioBytes = Buffer.byteLength(JSON.stringify(scenario)); assert.ok(scenarioBytes > 131072);
    const result = await loadCheck({ project: { repoPath, selection: { kind: 'critics', criticIds: ids.map(id => `${id}/review`) }, scenario }, concurrency: 32, outputDir: root, signal: AbortSignal.timeout(240000) });
    assert.equal(result.status, 'GREEN'); assert.equal(result.completed, ids.length);
    assert.equal(result.providerGuard.guardedToolCalls, ids.length);
    assert.ok(result.maxActive > 1 && result.maxActive <= 32);
    assert.equal(await readFile(join(folder, 'ccdd.json'), 'utf8'), manifest);
    assert.equal(existsSync(join(root, 'machine', 'identity-cache', 'cache.sqlite')), false);
    reports.largeCatalog = { selectedCritics: ids.length, scenarioBytes, completed: result.completed, toolCalls: result.providerGuard.guardedToolCalls, maxActive: result.maxActive, elapsedMs: result.elapsedMs, toolLatencyMs: result.toolLatencyMs };
    console.error(JSON.stringify({ phase: 'large-catalog', elapsedMs: result.elapsedMs }));

    // 1,000 explicit identities become 1,000 cache-owned executions (#104). A controlled
    // executor stands in for reviewers: this measures dispatch and workspace work, not reviews.
    const ownersRepo = join(root, 'owners'), owners = 1000;
    await mkdir(join(ownersRepo, 'family'), { recursive: true });
    for (let i = 0; i < 1000; i++) await writeFile(join(ownersRepo, `material-${i}.bin`), Buffer.alloc(32 * 1024, i % 251));
    await writeFile(join(ownersRepo, 'family', 'ccdd.json'), JSON.stringify({ name: 'owners', family: { instances: Object.fromEntries(Array.from({ length: owners }, (_, i) => [`owner-${i}`, {}])) },
      stale: { kind: 'identity', weight: 1, script: { command: 'node', args: ['identity.mjs'] } },
      critics: [{ id: 'review', title: 'Controlled executor', profile: { kind: 'runtime', command: 'node', args: ['--version'], timeoutMs: 5000 }, payload: { instruction: 'Controlled executor; not review evidence.' } }] }));
    await writeFile(join(ownersRepo, 'family', 'identity.mjs'), "let text='';for await(const chunk of process.stdin)text+=chunk;console.log('scale-'+JSON.parse(text).artifactId);\n");
    let observers = 0, walks = 0, starts = 0, firstStart;
    const watch = fs.watch, readdir = fsp.readdir;
    fs.watch = function (path, ...rest) { if (path === ownersRepo && rest[0]?.recursive) observers++; return watch.call(this, path, ...rest); };
    fsp.readdir = function (path, ...rest) { if (path === ownersRepo) walks++; return readdir.call(this, path, ...rest); };
    syncBuiltinESMExports();
    const bytesRead = () => process.platform === 'linux' ? Number(/rchar: (\d+)/.exec(readFileSync('/proc/self/io', 'utf8'))[1]) : 0;
    const broker = createBroker({ repoPath: ownersRepo, stateDir: join(root, 'owners-state'), repoId: 'owners', detail: 'full', executors: {
      canExecute: () => ({ ok: true }), execute: async () => { starts++; firstStart ??= performance.now(); return { verdict: 'GREEN' }; } } });
    try {
      const submitted = await broker.submitProject({ selection: { kind: 'all' } });
      observers = 0; walks = 0;
      const readBefore = bytesRead(), runStarted = performance.now();
      await broker.run(submitted.id, { signal: AbortSignal.timeout(240000) });
      const run = broker.getRun(submitted.id), elapsedMs = performance.now() - runStarted;
      assert.equal(run.status, 'GREEN'); assert.equal(starts, owners);
      assert.ok(run.requests.every(request => request.cacheDisposition === 'executed'));
      assert.equal(observers, 1, 'Only the submitting Run observes its workspace.');
      assert.ok(walks <= 3 + Math.ceil(elapsedMs / 1000), `${walks} workspace walks: an owner walked the workspace.`);
      assert.ok(firstStart - runStarted < 60000, `First cache-owned executor started after ${Math.round(firstStart - runStarted)} ms.`);
      reports.cacheOwners = { owners, firstExecutorStartMs: Math.round(firstStart - runStarted), elapsedMs: Math.round(elapsedMs), workspaceObservers: observers, workspaceWalks: walks,
        ...(process.platform === 'linux' ? { readMiB: Math.round((bytesRead() - readBefore) / 2 ** 20) } : {}), rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20) };
      console.error(JSON.stringify({ phase: 'cache-owners', ...reports.cacheOwners }));
    } finally { await broker.close(); fs.watch = watch; fsp.readdir = readdir; syncBuiltinESMExports(); }
    console.log(JSON.stringify({ status: 'PASS', diagnosticOnly: true, ...reports }, null, 2));
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}
