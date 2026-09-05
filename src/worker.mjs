import {createBroker} from './broker/index.mjs';
import {createExecutorRegistry} from './executors/index.mjs';
import {createLocalAlarmMethods} from './local.mjs';

// A single review owns this process; it never listens on a socket or accepts a queue.
const options=JSON.parse(process.argv[2]);
const {runId,codexPath,humanInbox,...context}=options;
const executors=createExecutorRegistry({codexPath,alarmMethods:createLocalAlarmMethods({...context,humanInbox})});
const controller=new AbortController();
const stop=()=>controller.abort(new Error('Review worker was stopped.'));
process.on('SIGINT',stop);process.on('SIGTERM',stop);
let broker;
const notify=message=>{
  if(!process.connected)return;
  // The submitting client may disappear; IPC failure must not stop owned work.
  try{process.send(message,()=>{if(process.connected){try{process.disconnect();}catch{}}});}catch{}
};
let notified=false;
try {
  broker=await createBroker({...context,executors});
  await broker.run(runId,{signal:controller.signal,onStarted:()=>{notified=true;notify({type:'ready',runId});}});
  if(!notified)notify({type:'ready',runId});
} catch(error) {
  notify({type:'error',message:error.message,code:error.code});
  if(error.code!=='RUN_ALREADY_OWNED'){
    try{await broker?.failRun?.(runId,error);}catch{}
    process.exitCode=2;
  }
} finally {
  await broker?.close();
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
