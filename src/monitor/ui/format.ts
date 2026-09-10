import type { MonitorRequest } from '../types.js';

export const kindLabels = { agent: 'Agent', human: 'Human', runtime: 'Runtime' } as const;
export function statusLabel(request: MonitorRequest): string {
  if (request.blockedByFailure) return 'Blocked by failure';
  if (request.status === 'WAITING_HUMAN') return request.claimedBy ? 'Reviewer working' : 'Awaiting reviewer';
  return { BLOCKED: 'Awaiting dependencies', QUEUED: 'Queued', RUNNING: 'Running', GREEN: 'Passed', RED: 'Criteria not met', ERROR: 'Execution error' }[request.status];
}
export function elapsed(start: string, end: string | null | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
