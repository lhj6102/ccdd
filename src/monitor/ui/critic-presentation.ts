import type { GraphCriticState } from '../../broker/graph.js';
import type { MonitorRequest } from '../types.js';
import { kindLabels } from './format.js';

export interface CriticPresentation {
  tone: 'requested' | 'running' | 'success' | 'failure' | 'omitted';
  mark: 'waiting' | 'running' | 'success' | 'failure' | 'error' | 'blocked' | 'omitted';
  label: string;
  accessibleLabel: string;
  actionable: boolean;
}

/** Keep omitted reviews, waiting on failures, and execution errors distinct. */
export function criticPresentation(critic: GraphCriticState, request?: MonitorRequest): CriticPresentation {
  const stored = request?.id === critic.requestId && request.criticId === critic.id ? request : undefined;
  let tone: CriticPresentation['tone'] = 'requested', mark: CriticPresentation['mark'] = 'waiting', label = 'Requested · Queued';
  const actionable = Boolean(critic.requestId && critic.status);
  if (critic.validationStatus === 'STALE' || critic.validationStatus === 'UNREVIEWED') {
    label = critic.validationStatus === 'STALE' ? 'Needs revalidation' : 'Unreviewed';
    return { tone, mark, label, actionable: false, accessibleLabel: `${critic.title} · ${label} · ${critic.validationReason ?? ''}` };
  }
  if (critic.validationStatus === 'BLOCKED') {
    label = 'Dependencies need validation';
    return { tone, mark, label, actionable: Boolean(critic.requestId), accessibleLabel: `${critic.title} · ${label} · ${critic.validationReason ?? ''}` };
  }
  if (!actionable) { tone = 'omitted'; mark = 'omitted'; label = 'Not included in this Run'; }
  else if (critic.status === 'BLOCKED') {
    if (stored?.blockedByFailure) { mark = 'blocked'; label = 'Blocked · Dependency failed'; }
    else label = 'Requested · Awaiting dependencies';
  } else if (critic.status === 'WAITING_HUMAN') {
    const claimedBy = stored ? stored.claimedBy : critic.claimedBy;
    if (claimedBy) { tone = 'running'; mark = 'running'; label = 'In review · Reviewer working'; }
    else label = 'Requested · Awaiting reviewer';
  } else if (critic.status === 'RUNNING') { tone = 'running'; mark = 'running'; label = 'In review'; }
  else if (critic.status === 'GREEN') { tone = 'success'; mark = 'success'; label = critic.reusedFrom ? 'Passed · Previous verdict reused' : 'Succeeded · Passed'; }
  else if (critic.status === 'RED') { tone = 'failure'; mark = 'failure'; label = 'Failed · Criteria not met'; }
  else if (critic.status === 'ERROR') { tone = 'failure'; mark = 'error'; label = 'Execution error'; }
  return { tone, mark, label, actionable, accessibleLabel: `${critic.title} · ${kindLabels[critic.kind]} · ${label}` };
}
