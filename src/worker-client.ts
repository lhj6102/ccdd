import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { PiOptions } from './executors/pi.js';
import type { createBroker } from './broker/index.js';
import { errorCode } from './executors/errors.js';

type Broker = ReturnType<typeof createBroker>;
type Run = NonNullable<ReturnType<Broker['getRun']>>;
export interface WorkerConfiguration { piOptions?: PiOptions; humanInbox: boolean }
export interface WorkerContext { repoPath: string; repoId: string; stateDir: string }
export interface WorkerOptions extends WorkerContext, WorkerConfiguration { runId: string }

export async function launchWorker({runId,repoPath,repoId,stateDir,piOptions,humanInbox}:WorkerOptions){
  const worker=fork(fileURLToPath(new URL('./worker.js',import.meta.url)),[JSON.stringify({runId,repoPath,repoId,stateDir,piOptions,humanInbox})],{
    detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[],
    env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT')),
  });
  await new Promise<void>((ok,no)=>{
    const timer=setTimeout(()=>finish(new Error('Review worker startup timed out.')),15000);
    const finish=(error?:Error)=>{clearTimeout(timer);worker.off('error',fail);worker.off('exit',exit);worker.off('message',message);if(error){worker.kill('SIGTERM');no(error);}else ok();};
    const fail=(error:Error)=>finish(error);
    const exit=(code:number|null)=>finish(new Error(`Review worker exited during startup (${code}).`));
    const message=(value: {type:string;message:string;code?:string})=>{if(value?.type==='ready')finish();else if(value?.type==='error')finish(Object.assign(new Error(value.message),{code:value.code}));};
    worker.once('error',fail);worker.once('exit',exit);worker.on('message',message);
  });
  worker.unref();
  worker.channel?.unref();
  return worker.pid;
}

/** The worker accepts only saved execution settings, never arbitrary spread-in identity fields. */
export async function readWorkerConfiguration(stateDir: string, runId: string): Promise<WorkerConfiguration> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error('Invalid Run identity.');
  const input: unknown = JSON.parse(await readFile(join(stateDir, 'runs', runId, 'worker.json'), 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid saved worker configuration.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['piOptions', 'humanInbox'].includes(key)) || typeof value.humanInbox !== 'boolean') throw new Error('Invalid saved worker configuration.');
  let piOptions: PiOptions | undefined;
  if (value.piOptions !== undefined) {
    if (!value.piOptions || typeof value.piOptions !== 'object' || Array.isArray(value.piOptions)) throw new Error('Invalid saved Provider settings.');
    const settings = value.piOptions as Record<string, unknown>;
    if (Object.keys(settings).some(key => !['authFile', 'codexAuthFile'].includes(key))) throw new Error('Invalid saved Provider settings.');
    piOptions = {};
    for (const key of ['authFile', 'codexAuthFile'] as const) {
      if (settings[key] !== undefined) {
        if (typeof settings[key] !== 'string' || !isAbsolute(settings[key])) throw new Error('Saved credential paths must be absolute.');
        piOptions[key] = settings[key];
      }
    }
  }
  return { humanInbox: value.humanInbox, ...(piOptions ? { piOptions } : {}) };
}

/** CLI and explicit monitor completion share durable, detached successor startup. */
export async function ensureRunWorker({ broker, context, run, initialConfig }: { broker: Broker; context: WorkerContext; run: Run; initialConfig?: WorkerConfiguration }): Promise<Run> {
  try {
    if (initialConfig) {
      const runDir = join(context.stateDir, 'runs', run.id);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      try { await writeFile(join(runDir, 'worker.json'), JSON.stringify(initialConfig), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
    }
    const config = await readWorkerConfiguration(context.stateDir, run.id);
    try { await launchWorker({ ...context, ...config, runId: run.id }); }
    catch (error) { if (errorCode(error) !== 'RUN_ALREADY_OWNED') throw error; }
  } catch (error) {
    try { await broker.failRun(run.id, error); } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runId: run.id });
  }
  const current = broker.getRun(run.id);
  if (!current) throw new Error('Review handle not found.');
  return current;
}
