import {createBroker} from './broker/index.js';
import {createExecutorRegistry} from './executors/index.js';
import {createLocalAlarmMethods} from './local.js';
import { WORKER_PROTOCOL, type WorkerOptions } from './worker-client.js';
import { errorMessage, errorCode } from './executors/errors.js';

// A single review owns this process; it never listens on a socket or accepts a queue.
const options=JSON.parse(process.argv[2]) as WorkerOptions & {workerProtocol?: string};
if (options.workerProtocol !== WORKER_PROTOCOL) throw new Error('Worker protocol mismatch; stop old workers and submit using the current CLI.');
const {runId,piOptions,humanInbox,workerProtocol,...context}=options;
const executors=createExecutorRegistry({piOptions,alarmMethods:createLocalAlarmMethods({...context,humanInbox})});
const controller=new AbortController();
const stop=()=>controller.abort(new Error('Review worker was stopped.'));
process.on('SIGINT',stop);process.on('SIGTERM',stop);
let broker:ReturnType<typeof createBroker<'full'>>|undefined;
const notify=(message:Record<string,unknown>)=>{
  if(!process.connected)return;
  // The submitting client may disappear; IPC failure must not stop owned work.
  try{process.send?.(message,()=>{if(process.connected){try{process.disconnect();}catch{}}});}catch{}
};
let notified=false;
try {
  broker=await createBroker({ detail: 'full',...context,executors});
  await broker.run(runId,{signal:controller.signal,onStarted:()=>{notified=true;notify({type:'ready',runId});}});
  if(!notified)notify({type:'ready',runId});
  // A terminal Run may still own a shared execution with other subscribers. Keep
  // serving it until it completes; an explicit stop uses the bounded close drain.
  await broker.drainShared(controller.signal);
} catch(error) {
  notify({type:'error',message:errorMessage(error),code:errorCode(error)});
  if(errorCode(error)!=='RUN_ALREADY_OWNED'){
    try{await broker?.failRun?.(runId,error);}catch{}
    process.exitCode=2;
  }
} finally {
  await broker?.close();
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
