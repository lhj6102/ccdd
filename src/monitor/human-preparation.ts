import type { ReviewRequest } from '../contracts.js';
import type { HumanPreparationPhase } from '../executors/human-preparation.js';
import type { MonitorHumanPreparation } from './types.js';

const phases = new Set<HumanPreparationPhase>(['validating-input', 'checking-manifest', 'checking-environment', 'preflighting-tools', 'final-validation', 'confirming-assignment']);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const failures = {
  cancelled: 'Preparation was cancelled. Retry Claim when ready.',
  'checks-failed': 'Environment or tool checks failed. Correct the reported problem and retry Claim.',
  'input-invalid': 'Fixed-input validation failed. Restore the recorded input or request a new review before retrying Claim.',
  'preparation-failed': 'Preparation stopped. Check the reported error and retry Claim when ready.',
} as const;

/** Expiration is an observation; a monitor GET never renews or releases a reservation. */
export function humanPreparationState(request: ReviewRequest, reviewerId?: string, now = Date.now()): MonitorHumanPreparation | undefined {
  const raw = request.preparationAttempt;
  if (!raw || !id(raw.id) || !id(raw.reviewerId) || !date(raw.startedAt) || !date(raw.expiresAt) || !date(raw.heartbeatAt) || !date(raw.phaseStartedAt) || !phases.has(raw.phase) ||
      !['preparing', 'released', 'expired', 'claimed'].includes(raw.status)) return undefined;
  let status = raw.status;
  if (status === 'preparing') {
    if (request.claimAttemptId === raw.id && request.claimedBy) status = 'claimed';
    else if (now >= Date.parse(raw.expiresAt)) status = 'expired';
    else if (request.status !== 'WAITING_HUMAN' || request.tryClaim?.id !== raw.id) status = 'released';
  }
  const completedAt = date(raw.completedAt) ? raw.completedAt : status === 'expired' ? raw.expiresAt : status === 'claimed' && date(request.claimedAt) ? request.claimedAt : undefined;
  const end = completedAt ? Date.parse(completedAt) : now;
  const failureCode = raw.failureCode && Object.hasOwn(failures, raw.failureCode) ? raw.failureCode : undefined;
  const timings = Array.isArray(raw.timings) ? raw.timings.slice(-12).filter(timing => timing && phases.has(timing.phase) && date(timing.startedAt) && date(timing.completedAt) && count(timing.durationMs))
    .map(({ phase, startedAt, completedAt, durationMs }) => ({ phase, startedAt, completedAt, durationMs })) : [];
  return {
    id: raw.id, reviewerId: raw.reviewerId, status, startedAt: raw.startedAt, expiresAt: raw.expiresAt,
    heartbeatAt: raw.heartbeatAt, phase: raw.phase, phaseStartedAt: raw.phaseStartedAt, timings,
    preparingByMe: raw.reviewerId === reviewerId, elapsedMs: Math.max(0, end - Date.parse(raw.startedAt)), phaseElapsedMs: Math.max(0, end - Date.parse(raw.phaseStartedAt)),
    ...(completedAt ? { completedAt } : {}), ...(id(raw.previousAttemptId) ? { previousAttemptId: raw.previousAttemptId } : {}),
    ...(raw.progress && ['metadata', 'content'].includes(raw.progress.kind) && count(raw.progress.files) && count(raw.progress.bytes) && typeof raw.progress.completed === 'boolean'
      ? { progress: { kind: raw.progress.kind, files: raw.progress.files, bytes: raw.progress.bytes, completed: raw.progress.completed } } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(status === 'released' ? { nextAction: failures[failureCode ?? 'preparation-failed'] }
      : status === 'expired' ? { nextAction: 'This preparation reservation expired. Retry Claim to start a new attempt.' } : {}),
  };
}
