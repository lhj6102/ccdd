import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createBroker } from '../broker/index.js';
import { ensureRunWorker } from '../worker-client.js';
import type { ReviewResult } from '../contracts.js';
import type { MonitorStoredRequest } from './store.js';

export class MonitorActionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Stored descriptors cannot expand access beyond the selected registered state source. */
export async function authorizeWorkspace(record: MonitorStoredRequest): Promise<void> {
  const { request, repoPath, stateDir, repoId } = record;
  const descriptor = request.workspace;
  if (!descriptor || request.repoId !== repoId || request.snapshotHash !== descriptor.hash || !/^[a-f0-9]{64}$/.test(request.snapshotHash) ||
      !isAbsolute(repoPath) || resolve(repoPath) !== repoPath || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir ||
      descriptor.sourcePath !== repoPath || descriptor.stateDir !== stateDir || await realpath(stateDir) !== stateDir ||
      descriptor.path !== (descriptor.mode === 'copy' ? join(stateDir, 'workspaces', descriptor.hash) : repoPath)) {
    throw new MonitorActionError(409, 'The review input does not match the stored project information.');
  }
  if (descriptor.mode === 'lock' && await realpath(repoPath) !== repoPath) throw new MonitorActionError(409, 'The original workspace path has changed.');
}

function available(record: MonitorStoredRequest, reviewerId: string, requireClaim: boolean): void {
  const request = record.request;
  if (request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new MonitorActionError(409, 'This request is not currently available for Human review.');
  if (request.claimedBy && request.claimedBy !== reviewerId) throw new MonitorActionError(403, 'Another reviewer has claimed this request.');
  if (requireClaim && request.claimedBy !== reviewerId) throw new MonitorActionError(403, 'Claim the review in this browser first.');
  if (requireClaim && !request.notifiedAt) throw new MonitorActionError(409, 'Checking review notification delivery. Please try again shortly.');
}

/** Mutations are explicitly requested; normal monitor reads never open a Broker. */
export async function claimReview(record: MonitorStoredRequest, reviewerId: string, signal?: AbortSignal): Promise<void> {
  available(record, reviewerId, false);
  await authorizeWorkspace(record);
  const broker = createBroker(record);
  try { await broker.claimHuman(record.request.id, reviewerId, { signal }); }
  finally { await broker.close(); }
}

export async function completeReview(record: MonitorStoredRequest, reviewerId: string, result: Pick<ReviewResult, 'verdict' | 'summary' | 'evidence'>): Promise<void> {
  available(record, reviewerId, true);
  await authorizeWorkspace(record);
  const broker = createBroker(record);
  try {
    await broker.completeHuman(record.request.id, { reviewerId, result });
    const run = broker.getRun(record.request.runId);
    if (run?.status === 'QUEUED') await ensureRunWorker({ broker, context: record, run });
  } finally { await broker.close(); }
}

export async function executeReviewTool(record: MonitorStoredRequest, reviewerId: string, toolName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  available(record, reviewerId, true);
  await authorizeWorkspace(record);
  signal.throwIfAborted();
  const broker = createBroker(record);
  try { return await broker.executeHumanTool(record.request.id, { reviewerId, toolName, arguments: args, signal }); }
  finally { await broker.close(); }
}
