import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { createBroker } from '../broker/index.js';
import { createReviewTools, describeReviewTools } from '../tools/runner.js';
import { diagnosticScope } from '../diagnostic-scope.js';
import { readWorkspaceConfig } from '../broker/config.js';
import { prepareReviewRequests } from '../requester/index.js';
import { includedCritics } from './query.js';
import { validateFinalResult } from '../response-schema.js';
import { validateArguments } from '../tools/schema.js';
import type { ProjectSelection } from './types.js';
import type { ToolResult } from '../tools/contracts.js';

function distribution(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0, p90: sorted[Math.max(0, Math.ceil(sorted.length * .9) - 1)] ?? 0, max: sorted.at(-1) ?? 0 };
}
export interface LoadCheckStep {
  /** Registered operation on the current Critic's target, or an exact registered tool name. */
  operation?: string; tool?: string;
  args?: Record<string, unknown>;
  /** JSON Pointer into an earlier ToolResult. No expressions, callbacks or evaluation. */
  argsFrom?: { step: number; pointer: string };
}
export interface LoadCheckProject {
  repoPath: string; selection: ProjectSelection; recursive?: boolean; ignoreGates?: boolean;
  scenario: { steps: LoadCheckStep[]; critics?: Record<string, LoadCheckStep[]>; syntheticResult?: Record<string, unknown>; criticResults?: Record<string, Record<string, unknown>> };
}
export interface LoadCheckOptions {
  concurrency?: number; requests?: number; processes?: number; outputDir?: string; signal?: AbortSignal;
  project?: LoadCheckProject;
  /** isolated creates a diagnostic-only machine pool; shared uses the existing machine configuration unchanged. */
  resourceMode?: 'isolated' | 'shared';
}
interface WorkerOptions { root: string; concurrency: number; requests: number; project?: LoadCheckProject }
function scenarioSteps(project: LoadCheckProject | undefined, criticId: string): LoadCheckStep[] { return project?.scenario.critics?.[criticId] ?? project?.scenario.steps ?? [{ operation: 'observe', args: {} }]; }
function validateSteps(steps: LoadCheckStep[]) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 64) throw new Error('A load-check scenario requires 1–64 steps.');
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Object.keys(step).some(key => !['operation', 'tool', 'args', 'argsFrom'].includes(key))) throw new Error('Invalid load-check scenario step.');
    if (Number(typeof step.operation === 'string') + Number(typeof step.tool === 'string') !== 1) throw new Error('A scenario step selects exactly one operation or tool.');
    if (step.args !== undefined && step.argsFrom !== undefined) throw new Error('A scenario step cannot combine args and argsFrom.');
    if (step.argsFrom !== undefined) {
      const ref = step.argsFrom;
      if (!ref || typeof ref !== 'object' || Object.keys(ref).some(key => !['step', 'pointer'].includes(key)) || !Number.isSafeInteger(ref.step) || ref.step < 0 || ref.step >= index || typeof ref.pointer !== 'string' || ref.pointer.length > 1000 || !/^(?:\/(?:[^~]|~[01])*)*$/.test(ref.pointer)) throw new Error('argsFrom must reference an earlier step with a valid JSON Pointer.');
    }
  });
}
function priorArguments(step: LoadCheckStep, results: ToolResult[]): unknown {
  if (!step.argsFrom) return step.args ?? {};
  let value: unknown = results[step.argsFrom.step];
  for (const part of step.argsFrom.pointer.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error(`Missing previous result at step ${step.argsFrom.step} pointer ${step.argsFrom.pointer}.`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
/** Real projects remain unchanged; only diagnostic state/output and generated fixtures are isolated. */
export async function loadCheck({ concurrency = 60, requests = concurrency, processes = 1, outputDir, signal, project, resourceMode = 'isolated' }: LoadCheckOptions = {}): Promise<Record<string, any>> {
  for (const [name, value] of Object.entries({ concurrency, requests, processes })) if (!Number.isSafeInteger(value) || value < 1 || value > (name === 'processes' ? 16 : 1000)) throw new Error(`${name} is outside the supported positive integer range.`);
  if (!['isolated', 'shared'].includes(resourceMode)) throw new Error('resourceMode must be isolated or shared.');
  if (project) { validateSteps(project.scenario?.steps); for (const steps of Object.values(project.scenario.critics ?? {})) validateSteps(steps); project = structuredClone({ ...project, repoPath: resolve(project.repoPath) }); }
  signal?.throwIfAborted();
  const base = resolve(outputDir ?? tmpdir()); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'ccdd-load-check-'));
  const config = join(root, 'config'); await mkdir(config);
  if (resourceMode === 'isolated') await writeFile(join(config, 'resources.json'), JSON.stringify({ defaultProviderCapacity: concurrency }));
  const started = performance.now();
  const workers = await Promise.all(Array.from({ length: processes }, async (_, index) => {
    const workerRoot = processes === 1 ? root : join(root, `process-${index}`); await mkdir(workerRoot, { recursive: true });
    return new Promise<Record<string, any>>((resolveResult, reject) => {
      const child = fork(fileURLToPath(new URL('./load-check-worker.js', import.meta.url)), [JSON.stringify({ root: workerRoot, concurrency, requests, project } satisfies WorkerOptions)], {
        execArgv: ['--import', fileURLToPath(new URL('../offline-guard.js', import.meta.url))], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1', CCDD_OFFLINE_GUARD_LOG: join(workerRoot, 'guard.jsonl'),
          ...(resourceMode === 'isolated' ? { CCDD_STATE_HOME: join(root, 'machine'), CCDD_CONFIG_HOME: config } : Object.fromEntries(['CCDD_STATE_HOME', 'CCDD_CONFIG_HOME', 'XDG_CONFIG_HOME'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))) },
      });
      let result: Record<string, any> | undefined, stderr = '';
      child.stderr?.on('data', data => { stderr = (stderr + data).slice(-4000); });
      child.on('message', value => { result = value as Record<string, any>; });
      const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
      child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
      child.on('exit', code => { signal?.removeEventListener('abort', abort); if (signal?.aborted) reject(signal.reason); else if (code || !result) reject(new Error(`Offline load check failed: ${stderr}`)); else resolveResult(result); });
      if (signal?.aborted) abort();
    });
  }));
  if (processes === 1) return { ...workers[0], resourceMode, processes };
  const elapsedMs = performance.now() - started, completed = workers.reduce((sum, worker) => sum + worker.completed, 0);
  const report = { diagnosticOnly: true, resourceMode, processes, requestedConcurrency: concurrency, completed, elapsedMs, throughputPerSecond: completed / (elapsedMs / 1000),
    status: workers.every(worker => worker.status === 'GREEN') ? 'GREEN' : 'ERROR', workers, output: join(root, 'report.json') };
  await writeFile(report.output, JSON.stringify(report, null, 2) + '\n'); return report;
}
export async function runDiagnostic({ root, concurrency, requests, project }: WorkerOptions) {
  if (Reflect.get(globalThis, Symbol.for('ccdd.offline-guard')) !== true) throw new Error('Offline diagnostics require the process guard.');
  let networkBlocked = false, providerBlocked = false;
  try { await fetch('https://example.invalid'); } catch { networkBlocked = true; }
  try { await import('@earendil-works/pi-ai'); } catch { providerBlocked = true; }
  if (!networkBlocked || !providerBlocked) throw new Error('Offline driver guard self-check failed.');
  const guard = fileURLToPath(new URL('../offline-guard.js', import.meta.url));
  return diagnosticScope.run({ guard }, async () => {
    const repoPath = project?.repoPath ?? join(root, 'fixture'), stateDir = join(root, 'diagnostic-state');
    if (!project) {
      await mkdir(repoPath);
      const name = `diagnostic-${randomUUID()}`, profile = { kind: 'agent', provider: '$offline', model: 'synthetic', reasoning: 'none' };
      await writeFile(join(repoPath, 'ccdd.json'), JSON.stringify({ name, views: { agentTools: { observe: { metadata: { description: 'Read a synthetic diagnostic fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, resultKinds: ['text'], observation: 'content' }, script: { command: 'node', args: ['tool.mjs'] } } } }, critics: Array.from({ length: requests }, (_, i) => ({ id: `load-${i}`, title: 'Offline diagnostic only', profile, payload: { instruction: 'Synthetic load-check fixture; not review evidence.' } })) }));
      await writeFile(join(repoPath, 'tool.mjs'), `if(Reflect.get(globalThis,Symbol.for('ccdd.offline-guard'))!==true)throw Error('missing child guard');for await(const chunk of process.stdin){};console.log(JSON.stringify({content:[{type:'text',text:'Guarded synthetic fixture'}],observation:{kind:'content'}}));`);
    }
    // Static validation precedes owner identities and all registered tool invocation.
    const { config } = await readWorkspaceConfig(repoPath);
    const ids = includedCritics({ config }, project?.selection ?? { kind: 'all' }, project?.recursive ?? false);
    if (!ids.length) throw new Error('Load-check selection has no Critics.');
    for (const id of ids) {
      const critic = config.critics.find(critic => critic.id === id)!;
      if (critic.profile.kind !== 'agent') throw new Error(`Load-check real-tool scenarios require Agent Critics: ${id}`);
      const envelope = (await prepareReviewRequests({ repoPath, repoId: 'diagnostic', snapshotHash: '0'.repeat(64), criticId: id, preparedConfig: config }))[0];
      validateFinalResult(project?.scenario.criticResults?.[id] ?? project?.scenario.syntheticResult ?? { verdict: 'GREEN' }, envelope);
      const tools = describeReviewTools({ ...envelope, audience: 'agent' }), steps = scenarioSteps(project, id); validateSteps(steps);
      for (const step of steps) {
        const name = step.tool ?? `${step.operation}_${critic.target}`, tool = tools.find(tool => tool.name === name);
        if (!tool) throw new Error(`Unknown registered scenario tool ${name} for ${id}.`);
        if (!step.argsFrom) validateArguments(tool.inputSchema, step.args ?? {});
      }
    }
    let active = 0, maxActive = 0, completed = 0; const latencies: number[] = [];
    const broker = createBroker({ detail: 'full', repoPath, stateDir, executors: {
      canExecute: () => ({ ok: true }), async execute(request, context) {
        active++; maxActive = Math.max(maxActive, active);
        let registry: Awaited<ReturnType<typeof createReviewTools>> | undefined;
        try {
          registry = await createReviewTools({ ...request, ...context, audience: 'agent' });
          const results: ToolResult[] = [];
          for (const step of scenarioSteps(project, request.criticId)) {
            const name = step.tool ?? `${step.operation}_${request.target}`, args = priorArguments(step, results);
            registry.validateArguments(name, args); const started = performance.now();
            const result = await registry.call(name, args); latencies.push(performance.now() - started);
            if (result.isError) throw new Error(`Diagnostic tool failed: ${name}`); results.push(result);
          }
          completed++; return { ...(project?.scenario.criticResults?.[request.criticId] ?? project?.scenario.syntheticResult ?? { verdict: 'GREEN' }), toolCalls: registry.toolCalls };
        } finally { await registry?.close(); active--; }
      },
    } });
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); const started = performance.now();
    try {
      const run = await broker.submitProject({ selection: project?.selection ?? { kind: 'all' }, recursive: project?.recursive, ignoreGates: project?.ignoreGates, force: true, maxExecutions: ids.length });
      let cursor = 0, changeCount = 0; const terminalChanges = new Map<string, string>();
      const drain = () => { for (;;) { const page = broker.changes(run.id, { after: cursor, limit: 100 })!; for (const change of page.changes) { changeCount++; terminalChanges.set(change.requestId, change.status); } cursor = page.cursor; if (!page.hasMore) break; } };
      const unsubscribe = broker.onChange(drain);
      try { drain(); await broker.run(run.id); drain(); } finally { unsubscribe(); }
      const final = broker.getRun(run.id)!;
      const elapsedMs = performance.now() - started;
      const proofs = (await readFile(join(root, 'guard.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const report = { diagnosticOnly: true, realProject: !!project, changeCursor: cursor, changeCount, terminalChanges: Object.fromEntries(terminalChanges), requestedConcurrency: concurrency, requests: ids.length, completed, maxActive, toolLatencyMs: distribution(latencies), eventLoopMaxMs: loop.max / 1e6,
        elapsedMs, throughputPerSecond: completed / (elapsedMs / 1000), status: final.status, errors: final.requests.filter(request => request.error).map(request => ({ criticId: request.criticId, error: request.error, code: request.errorCode })),
        providerGuard: { driverNetworkBlocked: networkBlocked, driverProviderImportBlocked: providerBlocked, guardedToolCalls: latencies.length, guardedNodeProcesses: proofs.length, proofFile: join(root, 'guard.jsonl'), scope: 'Node module imports and standard network APIs in driver, identity and tool Node children; not an OS sandbox or arbitrary native executable network isolation' },
        stateDir, runId: run.id, output: join(root, 'report.json') };
      await writeFile(report.output, JSON.stringify(report, null, 2) + '\n'); return report;
    } finally { loop.disable(); await broker.close(); }
  });
}
