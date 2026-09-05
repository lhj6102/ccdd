import type { MonitorRequest } from '../types.js';

export const kindLabels = { agent: 'Agent', human: 'Human', runtime: 'Runtime' } as const;
export function statusLabel(request: MonitorRequest): string {
  if (request.blockedByFailure) return '진행 불가';
  if (request.status === 'WAITING_HUMAN') return request.claimedBy ? '담당자 검토 중' : '담당자 기다림';
  return { BLOCKED: '선행 리뷰 대기', QUEUED: '실행 대기', RUNNING: '실행 중', GREEN: '통과', RED: '기준 미충족', ERROR: '실행 오류' }[request.status];
}
export function elapsed(start: string, end: string | null | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
  return `${Math.floor(seconds / 86400)}일 ${Math.floor((seconds % 86400) / 3600)}시간`;
}
export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
