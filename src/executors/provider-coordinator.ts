import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resourcePaths } from '../resources.js';

export interface ProviderCoordinator {
  wait(signal: AbortSignal, deadline: number): Promise<void>;
  defer(milliseconds: number): Promise<void>;
  block(code: 'AUTHENTICATION_FAILED' | 'QUOTA_EXHAUSTED'): Promise<void>;
  close(): void;
}
const filename = () => join(dirname(resourcePaths().database), 'providers.sqlite');
const busy = (cause: unknown) => !!cause && typeof cause === 'object' && (Number((cause as {errcode?:number}).errcode) & 255) === 5;
const failure = (code: string) => Object.assign(new Error(code), {code});
/** Hash credentials in memory: no token, credential path or Provider response is stored. */
export function providerLane(provider: string, credential: unknown): string {
  return createHash('sha256').update(provider).update('\0').update(JSON.stringify(credential) ?? '').digest('hex');
}
function open(file: string) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const db = new DatabaseSync(file,{timeout:5000});
  try {
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS provider_control(
      lane TEXT PRIMARY KEY,provider TEXT NOT NULL,until_ms INTEGER NOT NULL,blocked TEXT,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS provider_control_provider ON provider_control(provider);
      PRAGMA busy_timeout=25;`);
    chmodSync(file,0o600);return db;
  } catch(cause) {db.close();throw cause;}
}
/** Shared across local processes and repositories, independently of result identities. */
export function openProviderCoordinator(provider: string, lane: string, file = filename()): ProviderCoordinator {
  const db=open(file);let closed=false;
  const retry=async<T>(action:()=>T,signal?:AbortSignal):Promise<T>=>{
    const end=performance.now()+5000;
    for(;;){signal?.throwIfAborted();if(closed)throw failure('PROVIDER_CONTROL_CLOSED');
      try{return action();}catch(cause){if(!busy(cause)||performance.now()>=end)throw cause;}
      await delay(25,undefined,{signal});
    }
  };
  return {
    async wait(signal,deadline) {
      for(;;) {
        signal.throwIfAborted();
        const row=await retry(()=>db.prepare('SELECT until_ms,blocked FROM provider_control WHERE lane=?').get(lane),signal);
        if(row?.blocked)throw failure(String(row.blocked));
        const remaining=Number(row?.until_ms ?? 0)-Date.now();
        if(remaining<=0)return;
        if(performance.now()+remaining>=deadline)throw failure('PROVIDER_TIMEOUT');
        await delay(Math.min(remaining,1000),undefined,{signal});
      }
    },
    async defer(milliseconds) {
      if(!Number.isFinite(milliseconds)||milliseconds<0||milliseconds>2147483647)throw new Error('Invalid Provider cooldown.');
      await retry(()=>db.prepare(`INSERT INTO provider_control VALUES(?,?,?,NULL,?) ON CONFLICT(lane) DO UPDATE SET
        until_ms=MAX(until_ms,excluded.until_ms),updated_at=excluded.updated_at`).run(lane,provider,Date.now()+milliseconds,Date.now()));
    },
    async block(code) {
      await retry(()=>db.prepare(`INSERT INTO provider_control VALUES(?,?,0,?,?) ON CONFLICT(lane) DO UPDATE SET
        blocked=excluded.blocked,updated_at=excluded.updated_at`).run(lane,provider,code,Date.now()));
    },
    close(){if(!closed){closed=true;db.close();}},
  };
}
/** Operational state is inspected and resumed explicitly without a repository. */
export function providerStatus(file = filename()) {
  if(!existsSync(file))return [];
  const db=new DatabaseSync(file,{readOnly:true,timeout:5000});
  try{return db.prepare('SELECT provider,blocked,MAX(until_ms) AS cooldownUntil,COUNT(*) AS accounts FROM provider_control GROUP BY provider,blocked ORDER BY provider').all();}
  finally{db.close();}
}
export function resumeProvider(provider: string, file=filename()):number {
  if(!provider || provider.length>200)throw new Error('A Provider name is required.');
  if(!existsSync(file))return 0;
  const db=new DatabaseSync(file,{timeout:5000});
  try{return Number(db.prepare('DELETE FROM provider_control WHERE provider=?').run(provider).changes);}
  finally{db.close();}
}
