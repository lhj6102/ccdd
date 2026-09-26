// Controlled executor with real child-process tools; no Provider/model calls.
// Run each concurrency in a fresh process: CONCURRENCY=4/16/32/60 node --cpu-prof scripts/benchmark-request-manifest.mjs
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { createBroker, brokerTestHooks } from '../dist/src/broker/index.js';
import { readWorkspaceConfig } from '../dist/src/broker/config.js';
import { prepareReviewRequests } from '../dist/src/requester/index.js';
import { createReviewTools } from '../dist/src/tools/runner.js';
const count = Number(process.env.ARTIFACTS ?? 240), critics = Number(process.env.CRITICS ?? 180);
const concurrency = Number(process.env.CONCURRENCY ?? 60), calls = Number(process.env.CALLS ?? 4);
const root = await mkdtemp(join(process.env.BENCH_ROOT ?? tmpdir(), 'ccdd-manifest-bench-')), repoPath = join(root, 'repo'), stateDir = join(root, 'state');
await mkdir(repoPath);
let peakHeap = 0, phase = 'setup', active = 0, peakConcurrency = 0, completed = 0, hydratedBytes = 0;
const latencies = [], openings = [];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
const sample = () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };
const observer = new PerformanceObserver(sample); observer.observe({ entryTypes: ['gc'] });
const loop = monitorEventLoopDelay({ resolution: 10 });
const timer = setInterval(sample, 20); timer.unref();
let broker;
try {
  for (let i = 0; i < count; i++) {
    const name = `a${String(i).padStart(3, '0')}`, folder = join(repoPath, name); await mkdir(folder);
    const tools = Object.fromEntries(Array.from({ length: 12 }, (_, tool) => [`read${tool}`, {
      metadata: { description: 'Synthetic schema-heavy view', inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`field${n}`, { type: 'string', description: 'x'.repeat(490) }])) }, resultKinds: ['json'], observation: 'content' },
      script: { command: 'node', args: ['view.mjs'] },
    }]));
    const definition = { ...(i >= critics ? { basis: true } : {}), name, views: { agentTools: tools }, ...(i < critics ? { critics: [{ id: 'check', title: 'Synthetic review', profile: { kind: 'agent', provider: 'fixture', model: 'fixture', reasoning: 'none' }, payload: { instruction: 'Inspect the target.' } }] } : {}) };
    await writeFile(join(folder, 'ccdd.json'), JSON.stringify(definition));
    await writeFile(join(folder, 'view.mjs'), "let input=''; for await (const chunk of process.stdin) input+=chunk; const request=JSON.parse(input); process.stdout.write(JSON.stringify({content:[{type:'json',data:{artifact:request.context.artifactPath,value:42}}],observation:{kind:'content'}}));\n");
  }
  phase = 'sizing';
  { const { config } = await readWorkspaceConfig(repoPath); const [request] = await prepareReviewRequests({ repoPath, snapshotHash: 'a'.repeat(64), criticId: 'a000/check', preparedConfig: config });
    console.log(JSON.stringify({ phase, artifacts: count, critics, concurrency, definitionBytes: Buffer.byteLength(JSON.stringify(config.artifacts.a000)), envelopeBytes: Buffer.byteLength(JSON.stringify(request)), heapBytes: process.memoryUsage().heapUsed })); }
  if (!process.env.SIZE_ONLY) {
    phase = 'submit'; const started = performance.now();
    broker = createBroker({ repoPath, stateDir, maxConcurrentExecutors: concurrency, workspaceIntegrity: 'metadata', executors: {
      canExecute: () => ({ ok: true }), execute: async (request, context) => {
        peakConcurrency = Math.max(peakConcurrency, ++active); sample();
        const start = performance.now();
        const registry = await createReviewTools({ ...request, worktreePath: context.worktreePath, runDir: context.runDir, audience: 'agent', signal: context.signal,
          onCall: call => context.onEvent?.({ type: 'artifact.tool.called', ...call }),
          onExecution: execution => context.onEvent?.({ type: 'artifact.tool.completed', ...execution }) });
        openings.push(performance.now() - start);
        try {
          for (let call = 0; call < calls; call++) {
            const start = performance.now(), result = await registry.call(`read${call % 12}_${request.target}`, {});
            latencies.push(performance.now() - start);
            if (result.isError) throw new Error('Real benchmark tool failed.');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          sample(); completed++; return { verdict: 'GREEN', toolCalls: registry.toolCalls }; // Controlled fixture, not actual review evidence.
        } finally { active--; await registry.close(); }
      },
    } });
    const run = await broker.submitProject({ selection: { kind: 'all' }, force: true }); sample();
    const db = new DatabaseSync(join(stateDir, 'broker.sqlite'), { readOnly: true });
    const bytes = db.prepare('SELECT count(*) AS requests, sum(length(CAST(data AS BLOB))) AS totalBytes, avg(length(CAST(data AS BLOB))) AS bytesPerRequest FROM requests').get();
    const runBytes = db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM runs WHERE id = ?').get(run.id).bytes; db.close();
    console.log(JSON.stringify({ phase, ...bytes, runBytes, peakHeapBytes: peakHeap, elapsedMs: performance.now() - started }));
    phase = 'run'; const runStart = performance.now(), cpu = process.cpuUsage();
    brokerTestHooks.onHydrate = bytes => { hydratedBytes += bytes; }; loop.enable();
    const result = await broker.run(run.id); sample(); loop.disable();
    console.log(JSON.stringify({ phase, status: result.status, completed, peakConcurrency, peakHeapBytes: peakHeap, maxRssKiB: process.resourceUsage().maxRSS, elapsedMs: performance.now() - runStart,
      cpu: process.cpuUsage(cpu), hydratedBytes, tools: { count: latencies.length, p50Ms: percentile(latencies, .5), p90Ms: percentile(latencies, .9), maxMs: Math.max(...latencies) },
      registryOpen: { p50Ms: percentile(openings, .5), p90Ms: percentile(openings, .9) }, eventLoop: { p50Ms: loop.percentile(50) / 1e6, p90Ms: loop.percentile(90) / 1e6, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6 } }));
    if (result.status !== 'GREEN' || completed !== critics || latencies.length !== critics * calls) throw new Error('Controlled execution did not complete.');
  }
} finally { clearInterval(timer); observer.disconnect(); loop.disable(); delete brokerTestHooks.onHydrate; await broker?.close(); await rm(root, { recursive: true, force: true }); }
