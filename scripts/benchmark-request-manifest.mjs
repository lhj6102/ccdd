// Controlled fake executor benchmark; no Provider calls or fabricated review evidence.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { createBroker } from '../dist/src/broker/index.js';
import { readWorkspaceConfig } from '../dist/src/broker/config.js';
import { prepareReviewRequests } from '../dist/src/requester/index.js';
import { createReviewTools } from '../dist/src/tools/runner.js';
const count = Number(process.env.ARTIFACTS ?? 300), critics = Number(process.env.CRITICS ?? 180);
const root = await mkdtemp(join(tmpdir(), 'ccdd-manifest-bench-')), repoPath = join(root, 'repo'), stateDir = join(root, 'state');
await mkdir(repoPath);
let peakHeap = 0, phase = 'setup', active = 0, peakConcurrency = 0, completed = 0;
const sample = () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };
const observer = new PerformanceObserver(sample); observer.observe({ entryTypes: ['gc'] });
const timer = setInterval(sample, 5); timer.unref();
let broker;
try {
  for (let i = 0; i < count; i++) {
    const folder = join(repoPath, `a${String(i).padStart(3, '0')}`); await mkdir(folder);
    const definition = { ...(i >= critics ? { basis: true } : {}), name: `a${String(i).padStart(3, '0')}`, views: { agentTools: { read: {
      metadata: { description: 'Synthetic schema-heavy view', inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`field${n}`, { type: 'string', description: 'x'.repeat(440) }])) }, resultKinds: ['text'], observation: 'content' },
      script: { command: 'node', args: ['view.mjs'] },
    } } }, ...(i < critics ? { critics: [{ id: 'check', title: 'Synthetic review', profile: { kind: 'agent', provider: 'fixture', model: 'fixture', reasoning: 'none' }, payload: { instruction: 'Inspect the target.' } }] } : {}) };
    await writeFile(join(folder, 'ccdd.json'), JSON.stringify(definition));
  }
  phase = 'sizing';
  { const { config } = await readWorkspaceConfig(repoPath); const [request] = await prepareReviewRequests({ repoPath, snapshotHash: 'a'.repeat(64), criticId: 'a000/check', preparedConfig: config });
    console.log(JSON.stringify({ phase, artifacts: count, critics, definitionBytes: Buffer.byteLength(JSON.stringify(config.artifacts.a000)), envelopeBytes: Buffer.byteLength(JSON.stringify(request)), heapBytes: process.memoryUsage().heapUsed })); }
  if (process.env.SIZE_ONLY) {
    await rm(root, { recursive: true, force: true });
    process.exit(0);
  }
  phase = 'submit'; const started = performance.now();
  broker = createBroker({ repoPath, stateDir, maxConcurrentExecutors: 60, executors: {
    canExecute: () => ({ ok: true }), execute: async (request, context) => {
      peakConcurrency = Math.max(peakConcurrency, ++active); sample();
      const registry = await createReviewTools({ worktreePath: repoPath, artifacts: request.artifacts, configManifest: request.configManifest, criticId: request.criticId, audience: 'agent', signal: context.signal });
      try { await new Promise(resolve => setTimeout(resolve, 20)); sample(); completed++; return { verdict: 'GREEN' }; }
      finally { active--; await registry.close(); }
    },
  } });
  const run = await broker.submitProject({ selection: { kind: 'all' } }); sample();
  const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true });
  const bytes = db.prepare('SELECT count(*) AS requests, sum(length(CAST(data AS BLOB))) AS totalBytes, avg(length(CAST(data AS BLOB))) AS bytesPerRequest FROM requests').get(); db.close();
  console.log(JSON.stringify({ phase, ...bytes, peakHeapBytes: peakHeap, elapsedMs: performance.now() - started }));
  phase = 'run'; const result = await broker.run(run.id); sample();
  console.log(JSON.stringify({ phase, status: result.status, completed, peakConcurrency, peakHeapBytes: peakHeap, maxRssKiB: process.resourceUsage().maxRSS, elapsedMs: performance.now() - started }));
  if (peakHeap > 1024 ** 3) throw new Error('Synthetic execution exceeded the 1 GiB sampled heap budget.');
  if (result.status !== 'GREEN' || completed !== critics) throw new Error('Synthetic execution did not complete.');
} catch (error) {
  sample(); console.log(JSON.stringify({ phase, failed: String(error), peakHeapBytes: peakHeap, maxRssKiB: process.resourceUsage().maxRSS, completed }));
  try { const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true }); console.log(JSON.stringify(db.prepare('SELECT count(*) AS storedRequests, coalesce(sum(length(CAST(data AS BLOB))), 0) AS storedBytes FROM requests').get())); db.close(); } catch {}
  throw error;
} finally { clearInterval(timer); observer.disconnect(); await broker?.close(); await rm(root, { recursive: true, force: true }); }
