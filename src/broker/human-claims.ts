import { randomUUID } from 'node:crypto';
import type { ReviewRequest } from '../contracts.js';
import type { HumanPreparation, HumanPreparationPhase, HumanPreparationProgress } from '../executors/human-preparation.js';
import type { WorkspaceScanProgress } from '../workspaces/index.js';
import { describeReviewTools } from '../tools/runner.js';

export const HUMAN_PREPARATION_LEASE_MS = 120_000;
export interface HumanTryClaim {
  id: string;
  reviewerId: string;
  startedAt: string;
  expiresAt: string;
}
export interface HumanPreparationAttempt extends HumanTryClaim {
  status: 'preparing' | 'released' | 'expired' | 'claimed';
  heartbeatAt: string;
  phase: HumanPreparationPhase;
  phaseStartedAt: string;
  completedAt?: string;
  previousAttemptId?: string;
  timings: { phase: HumanPreparationPhase; startedAt: string; completedAt: string; durationMs: number }[];
  progress?: WorkspaceScanProgress;
  failureCode?: 'cancelled' | 'checks-failed' | 'input-invalid' | 'preparation-failed';
}
export function activeTryClaim(request: Pick<ReviewRequest, 'tryClaim'>, at = Date.now()): HumanTryClaim | undefined {
  return request.tryClaim && Date.parse(request.tryClaim.expiresAt) > at ? request.tryClaim : undefined;
}

interface ClaimStore {
  transaction<T>(action: () => T): T;
  read(id: string): ReviewRequest | null;
  save(request: ReviewRequest): unknown;
  event(request: ReviewRequest, type: string, message: string): void;
  assertWaiting(request: ReviewRequest): void;
  changed(): void;
}

/** All assignment transitions compare a persisted attempt inside one transaction. */
export function createHumanClaims(store: ClaimStore) {
  const finishPhase = (preparation: HumanPreparationAttempt, at: string) => {
    preparation.timings.push({ phase: preparation.phase, startedAt: preparation.phaseStartedAt, completedAt: at, durationMs: Math.max(0, Date.parse(at) - Date.parse(preparation.phaseStartedAt)) });
    preparation.timings = preparation.timings.slice(-12);
  };
  const waiting = (id: string, reviewerId: string) => {
    if (typeof reviewerId !== 'string' || !reviewerId.trim() || reviewerId.length > 200) throw new Error('A reviewerId is required.');
    const request = store.read(id);
    if (!request || request.profile.kind !== 'human' || request.status !== 'WAITING_HUMAN') throw new Error('Request is not waiting for a human review.');
    store.assertWaiting(request);
    return request;
  };
  const lease = (milliseconds = HUMAN_PREPARATION_LEASE_MS) => {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 20 || milliseconds > 3_600_000) throw new Error('Invalid Human preparation lease duration.');
    return milliseconds;
  };
  const attempt = (id: string, reviewerId: string, attemptId: string) => {
    const request = waiting(id, reviewerId);
    if (request.claimedBy || !activeTryClaim(request) || request.tryClaim!.reviewerId !== reviewerId || request.tryClaim!.id !== attemptId) {
      throw new Error('This Try Claim expired or is no longer owned by this attempt.');
    }
    return request;
  };
  return {
    begin(id: string, reviewerId: string, leaseMs?: number): HumanTryClaim {
      const duration = lease(leaseMs);
      const result = store.transaction(() => {
        const request = waiting(id, reviewerId);
        if (request.claimedBy) throw new Error('This review is already claimed by a reviewer.');
        if (activeTryClaim(request)) throw new Error('This review is being prepared by another claim attempt.');
        const previousAttemptId = request.tryClaim?.id ?? request.preparationAttempt?.id;
        if (request.tryClaim) store.event(request, 'human.claim.expired', `Preparation attempt ${request.tryClaim.id} expired.`);
        const startedAt = new Date().toISOString();
        request.tryClaim = { id: randomUUID(), reviewerId, startedAt, expiresAt: new Date(Date.now() + duration).toISOString() };
        request.preparationAttempt = { ...request.tryClaim, status: 'preparing', heartbeatAt: startedAt, phase: 'validating-input', phaseStartedAt: startedAt, timings: [], ...(previousAttemptId ? { previousAttemptId } : {}) };
        store.save(request); store.event(request, 'human.claim.preparing', `Human preparation attempt ${request.tryClaim.id} started${previousAttemptId ? ` after ${previousAttemptId}` : ''}.`);
        return structuredClone(request.tryClaim);
      });
      store.changed(); return result;
    },
    renew(id: string, reviewerId: string, attemptId: string, leaseMs?: number): HumanTryClaim {
      const duration = lease(leaseMs);
      const result = store.transaction(() => {
        const request = attempt(id, reviewerId, attemptId);
        request.tryClaim!.expiresAt = new Date(Date.now() + duration).toISOString();
        if (request.preparationAttempt?.id === attemptId) {
          request.preparationAttempt.expiresAt = request.tryClaim!.expiresAt;
          request.preparationAttempt.heartbeatAt = new Date().toISOString();
        }
        store.save(request); return structuredClone(request.tryClaim!);
      });
      store.changed(); return result;
    },
    progress(id: string, reviewerId: string, attemptId: string, update: HumanPreparationProgress): void {
      store.transaction(() => {
        const request = attempt(id, reviewerId, attemptId), preparation = request.preparationAttempt;
        if (!preparation || preparation.id !== attemptId) return;
        const at = new Date().toISOString();
        if (preparation.phase !== update.phase) {
          finishPhase(preparation, at);
          preparation.phase = update.phase; preparation.phaseStartedAt = at;
          if (update.phase !== 'confirming-assignment') delete preparation.progress;
        }
        preparation.heartbeatAt = at;
        if (update.progress) preparation.progress = { ...update.progress };
        store.save(request);
      });
      store.changed();
    },
    release(id: string, reviewerId: string, attemptId: string, failureCode?: HumanPreparationAttempt['failureCode']): boolean {
      const released = store.transaction(() => {
        const request = store.read(id);
        if (!request || request.status !== 'WAITING_HUMAN' || request.claimedBy || request.tryClaim?.id !== attemptId || request.tryClaim.reviewerId !== reviewerId) return false;
        const expired = !activeTryClaim(request);
        if (request.preparationAttempt?.id === attemptId) {
          const preparation = request.preparationAttempt;
          preparation.status = expired ? 'expired' : 'released';
          preparation.completedAt = expired ? preparation.expiresAt : new Date().toISOString();
          if (failureCode) preparation.failureCode = failureCode;
          finishPhase(preparation, preparation.completedAt);
        }
        delete request.tryClaim;
        store.save(request); store.event(request, expired ? 'human.claim.expired' : 'human.claim.released', `Human preparation attempt ${attemptId} ${expired ? 'expired' : 'was released'}; retry Claim when ready.`);
        return true;
      });
      if (released) store.changed(); return released;
    },
    confirm(id: string, reviewerId: string, attemptId: string, preparation: HumanPreparation): ReviewRequest {
      const result = store.transaction(() => {
        const request = attempt(id, reviewerId, attemptId);
        if (!preparation || preparation.snapshotHash !== request.snapshotHash || preparation.configHash !== request.configManifest?.configHash) throw new Error('Preparation does not match the recorded snapshot and tool definitions.');
        const envIds = Object.keys(request.configManifest?.envRequirements ?? {}).sort();
        if (!Array.isArray(preparation.environment) || !Array.isArray(preparation.tools) ||
            preparation.environment.some(check => !check || check.ok !== true || typeof check.id !== 'string') ||
            preparation.environment.map(check => check.id).sort().join('\0') !== envIds.join('\0') ||
            preparation.tools.some(check => !check || check.ok !== true || typeof check.toolName !== 'string')) throw new Error('All required preparation checks must succeed before Claim.');
        if (request.configManifest) {
          const expectedTools = describeReviewTools({ artifacts: request.artifacts, configManifest: request.configManifest, audience: 'human' }).map(tool => `${tool.artifactId}/${tool.name}`).sort();
          const checkedTools = preparation.tools.map(tool => `${tool.artifactId}/${tool.toolName}`).sort();
          if (expectedTools.join('\0') !== checkedTools.join('\0')) throw new Error('Preparation must check every registered Human tool in this request.');
        }
        request.claimedBy = reviewerId; request.claimedAt = new Date().toISOString();
        request.claimAttemptId = attemptId;
        if (request.preparationAttempt?.id === attemptId) {
          request.preparationAttempt.status = 'claimed'; request.preparationAttempt.completedAt = request.claimedAt;
          finishPhase(request.preparationAttempt, request.claimedAt);
        }
        delete request.tryClaim;
        store.save(request); store.event(request, 'human.claimed', `Review claimed by ${reviewerId}.`);
        return request;
      });
      store.changed(); return result;
    },
  };
}
