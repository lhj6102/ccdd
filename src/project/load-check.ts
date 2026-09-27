import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { createBroker } from '../broker/index.js';
import { createReviewTools } from '../tools/runner.js';
import { diagnosticScope } from '../diagnostic-scope.js';

function distribution(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0, p90: sorted[Math.max(0, Math.ceil(sorted.length * .9) - 1)] ?? 0, max: sorted.at(-1) ?? 0 };
}
export interface LoadCheckOptions { concurrency?: number; requests?: number; outputDir?: string; signal?: AbortSignal }
/** Runs only a generated fixture, in a guarded process with independent diagnostic state. */
export async function loadCheck({ concurrency = 60, requests = concurrency, outputDir, signal }: LoadCheckOptions = {}) {
  for (const [name, value] of Object.entries({ concurrency, requests })) if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error(`${name} must be an integer from 1 to 1000.`);
  signal?.throwIfAborted();
  const base = resolve(outputDir ?? tmpdir()); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'ccdd-load-check-'));
  const config = join(root, 'config'); await mkdir(config);
  await writeFile(join(config, 'resources.json'), JSON.stringify({ defaultProviderCapacity: concurrency }));
  return new Promise<Record<string, any>>((resolveResult, reject) => {
    const child = fork(fileURLToPath(new URL('./load-check-worker.js', import.meta.url)), [JSON.stringify({ root, concurrency, requests })], {
      execArgv: ['--import', fileURLToPath(new URL('../offline-guard.js', import.meta.url))], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, HOME: root, NODE_NO_WARNINGS: '1', CCDD_STATE_HOME: join(root, 'machine'), CCDD_CONFIG_HOME: config },
    });
    let result: Record<string, any> | undefined, stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('message', value => { result = value as Record<string, any>; });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.on('exit', code => { signal?.removeEventListener('abort', abort); if (signal?.aborted) reject(signal.reason); else if (code || !result) reject(new Error(`Offline load check failed: ${stderr}`)); else resolveResult(result); });
    if (signal?.aborted) abort();
  });
}
export async function runDiagnostic({ root, concurrency, requests }: { root: string; concurrency: number; requests: number }) {
  if (Reflect.get(globalThis, Symbol.for('ccdd.offline-guard')) !== true) throw new Error('Offline diagnostics require the process guard.');
  let networkBlocked = false, providerBlocked = false;
  try { await fetch('https://example.invalid'); } catch { networkBlocked = true; }
  try { await import('@earendil-works/pi-ai'); } catch { providerBlocked = true; }
  if (!networkBlocked || !providerBlocked) throw new Error('Offline driver guard self-check failed.');
  const guard = fileURLToPath(new URL('../offline-guard.js', import.meta.url));
  return diagnosticScope.run({ guard }, async () => {
    const repoPath = join(root, 'fixture'), stateDir = join(root, 'diagnostic-state'); await mkdir(repoPath);
    const name = `diagnostic-${randomUUID()}`;
    const profile = { kind: 'agent', provider: '$offline', model: 'synthetic', reasoning: 'none' };
    await writeFile(join(repoPath, 'ccdd.json'), JSON.stringify({ name, views: { agentTools: { observe: { metadata: { description: 'Read a synthetic diagnostic fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text'], observation: 'content' }, script: { command: 'node', args: ['tool.mjs'] } } } }, critics: Array.from({ length: requests }, (_, i) => ({ id: `load-${i}`, title: 'Offline diagnostic only', profile, payload: { instruction: 'Synthetic load-check fixture; not review evidence.' } })) }));
    await writeFile(join(repoPath, 'tool.mjs'), `if(Reflect.get(globalThis,Symbol.for('ccdd.offline-guard'))!==true)throw Error('missing child guard');let blocked=false;try{await fetch('https://example.invalid')}catch{blocked=true}if(!blocked)throw Error('child guard failed');for await(const chunk of process.stdin){};console.log(JSON.stringify({content:[{type:'text',text:'Guarded synthetic fixture'}],observation:{kind:'content'}}));`);
    let active = 0, maxActive = 0, completed = 0; const latencies: number[] = [];
    const broker = createBroker({ detail: 'full', repoPath, stateDir, executors: {
      canExecute: () => ({ ok: true }), async execute(request, context) {
        active++; maxActive = Math.max(maxActive, active);
        let registry: Awaited<ReturnType<typeof createReviewTools>> | undefined;
        try {
          registry = await createReviewTools({ ...request, ...context, audience: 'agent' });
          const started = performance.now(), result = await registry.call(`observe_${name}`, {}); latencies.push(performance.now() - started);
          if (result.isError) throw new Error('Diagnostic tool failed.'); completed++;
          return { verdict: 'GREEN', toolCalls: registry.toolCalls };
        } finally { await registry?.close(); active--; }
      },
    } });
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); const started = performance.now();
    try {
      const run = await broker.submitProject({ selection: { kind: 'all' }, force: true, maxExecutions: requests });
      await broker.run(run.id);
      const final = broker.getRun(run.id)!;
      const elapsedMs = performance.now() - started;
      const report = { diagnosticOnly: true, requestedConcurrency: concurrency, requests, completed, maxActive, toolLatencyMs: distribution(latencies), eventLoopMaxMs: loop.max / 1e6,
        elapsedMs, throughputPerSecond: completed / (elapsedMs / 1000), status: final.status, errors: final.requests.filter(request => request.error).map(request => request.error),
        providerGuard: { driverNetworkBlocked: networkBlocked, driverProviderImportBlocked: providerBlocked, guardedToolCalls: latencies.length, scope: 'Node module imports and standard network APIs in generated driver/tools; not an OS sandbox or arbitrary executable network isolation' },
        stateDir, runId: run.id, output: join(root, 'report.json') };
      await writeFile(report.output, JSON.stringify(report, null, 2) + '\n'); return report;
    } finally { loop.disable(); await broker.close(); }
  });
}
