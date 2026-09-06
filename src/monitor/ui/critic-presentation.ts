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
  let tone: CriticPresentation['tone'] = 'requested', mark: CriticPresentation['mark'] = 'waiting', label = '요청 · 실행 대기';
  const actionable = Boolean(critic.requestId && critic.status);
  if (!actionable) { tone = 'omitted'; mark = 'omitted'; label = '이번 실행에 포함되지 않음'; }
  else if (critic.status === 'BLOCKED') {
    if (stored?.blockedByFailure) { mark = 'blocked'; label = '진행 불가 · 선행 평가 실패'; }
    else label = '요청 · 선행 평가 대기';
  } else if (critic.status === 'WAITING_HUMAN') {
    const claimedBy = stored ? stored.claimedBy : critic.claimedBy;
    if (claimedBy) { tone = 'running'; mark = 'running'; label = '리뷰 중 · 담당자 검토 중'; }
    else label = '요청 · 담당자 기다림';
  } else if (critic.status === 'RUNNING') { tone = 'running'; mark = 'running'; label = '리뷰 중'; }
  else if (critic.status === 'GREEN') { tone = 'success'; mark = 'success'; label = '성공 · 통과'; }
  else if (critic.status === 'RED') { tone = 'failure'; mark = 'failure'; label = '평가 실패 · 기준 미충족'; }
  else if (critic.status === 'ERROR') { tone = 'failure'; mark = 'error'; label = '실행 오류'; }
  return { tone, mark, label, actionable, accessibleLabel: `${critic.title} · ${kindLabels[critic.kind]} · ${label}` };
}
