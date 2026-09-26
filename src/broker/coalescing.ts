import type { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type { ReviewRequest } from '../contracts.js';
import type { RunRecord } from './index.js';
import { ownerAlive, type OwnerRecord } from './ownership.js';

const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
interface CoalescingOptions {
  /** Submission reconciles durably; readonly inspection leaves this absent. */
  reconcile?: (runId: string) => void;
  /** A waiting Broker retains monotonic lease bounds; a fresh quote has no prior observations. */
  deadlines?: Map<string, number>;
}

/** One adoption rule. A dead owner is ineligible even without writing WORKER_EXITED. */
export function coalescingEligibility(database: DatabaseSync, request: ReviewRequest, options: CoalescingOptions = {}): { leaseExpiresAt?: string } | null {
  if (!['QUEUED', 'RUNNING', 'WAITING_HUMAN'].includes(request.status)) return null;
  options.reconcile?.(request.runId);
  const row = database.prepare("SELECT json_object('id',json_extract(data,'$.id'),'status',json_extract(data,'$.status'),'createdAt',json_extract(data,'$.createdAt'),'coalescingGraceMs',json_extract(data,'$.coalescingGraceMs')) AS data FROM runs WHERE id = ?").get(request.runId);
  if (!row) return null;
  const source = JSON.parse(String(row.data)) as RunRecord;
  if (terminal.has(source.status)) return null;
  const owner = database.prepare('SELECT * FROM run_owners WHERE run_id = ?').get(source.id) as OwnerRecord | undefined;
  // Never fall back to the submission lease for a dead owner. The write path
  // reconciles it using the same PID/process identity check and owner token.
  if (owner) return ownerAlive(owner) ? {} : null;
  const grace = source.coalescingGraceMs;
  if (request.status !== 'QUEUED' || typeof grace !== 'number' || !Number.isSafeInteger(grace) || grace <= 0 || grace > 300_000) return null;
  const submitted = typeof source.createdAt === 'string' ? Date.parse(source.createdAt) : NaN;
  const elapsed = Date.now() - submitted;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= grace) return null;
  const tick = performance.now();
  const deadline = Math.min(options.deadlines?.get(source.id) ?? Infinity, tick + grace - elapsed);
  options.deadlines?.set(source.id, deadline);
  return tick < deadline ? { leaseExpiresAt: new Date(submitted + grace).toISOString() } : null;
}

/** Stable candidate order is shared by readonly quotes and transactional adoption. */
export function findCoalescibleRequest(database: DatabaseSync, criticId: string, inputKey: string, options: CoalescingOptions = {}) {
  const rows = database.prepare("SELECT data FROM requests WHERE status IN ('QUEUED','RUNNING','WAITING_HUMAN') AND json_extract(data, '$.criticId') = ? AND json_extract(data, '$.validationInput.key') = ? AND json_extract(data, '$.validationInput.version') = 3 ORDER BY rowid").all(criticId, inputKey);
  for (const row of rows) {
    const request = JSON.parse(String(row.data)) as ReviewRequest;
    const eligibility = coalescingEligibility(database, request, options);
    if (eligibility) return { request, ...eligibility };
  }
  return null;
}
