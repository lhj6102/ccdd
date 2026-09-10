import { randomUUID } from 'node:crypto';
import type { ReviewRequest } from '../contracts.js';
import type { HumanPreparation } from '../executors/human-preparation.js';
import { describeReviewTools } from '../tools/runner.js';

export const HUMAN_PREPARATION_LEASE_MS = 120_000;
export interface HumanTryClaim {
  id: string;
  reviewerId: string;
  startedAt: string;
  expiresAt: string;
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
        if (request.tryClaim) store.event(request, 'human.claim.expired', 'The previous preparation reservation expired.');
        request.tryClaim = { id: randomUUID(), reviewerId, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + duration).toISOString() };
        store.save(request); store.event(request, 'human.claim.preparing', 'Human claim preparation started.');
        return structuredClone(request.tryClaim);
      });
      store.changed(); return result;
    },
    renew(id: string, reviewerId: string, attemptId: string, leaseMs?: number): HumanTryClaim {
      const duration = lease(leaseMs);
      const result = store.transaction(() => {
        const request = attempt(id, reviewerId, attemptId);
        request.tryClaim!.expiresAt = new Date(Date.now() + duration).toISOString();
        store.save(request); return structuredClone(request.tryClaim!);
      });
      store.changed(); return result;
    },
    release(id: string, reviewerId: string, attemptId: string): boolean {
      const released = store.transaction(() => {
        const request = store.read(id);
        if (!request || request.status !== 'WAITING_HUMAN' || request.claimedBy || request.tryClaim?.id !== attemptId || request.tryClaim.reviewerId !== reviewerId) return false;
        delete request.tryClaim;
        store.save(request); store.event(request, 'human.claim.released', 'Human preparation did not complete; the request is available again.');
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
        delete request.tryClaim;
        store.save(request); store.event(request, 'human.claimed', `Review claimed by ${reviewerId}.`);
        return request;
      });
      store.changed(); return result;
    },
  };
}
