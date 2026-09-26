import { semanticResult } from './response-schema.js';
import { resolve } from 'node:path';
import type { ReviewRequest } from './contracts.js';
import type { RunView } from './broker/index.js';
import type { CriticValidation, ProjectPlan, ProjectQuery, ValidationEvidence } from './project/types.js';

export type ResultDetail = 'compact' | 'full';
export interface ResultOptions<D extends ResultDetail = 'compact'> { detail?: D }
export type ResultView<D extends ResultDetail, Full, Compact> = D extends 'full' ? Full : Compact;
export interface ReviewReference { runId: string; requestId: string | null; stateDir: string }
export interface RequesterResult {
  verdict: 'GREEN' | 'RED'; reference: ReviewReference; reusedFrom?: ReviewReference; [field: string]: unknown;
}
export interface RequesterRequest {
  id: string; runId: string; criticId: string; target: string; status: ReviewRequest['status'];
  inputKey: string | null; reference: ReviewReference; result: RequesterResult | null;
  error?: string | null; errorCode?: string | null; blockedReason?: string | null;
}
export interface ResultReference { requestId: string }
export type RequesterCritic = Omit<CriticValidation, 'input' | 'result'> & { inputKey: string; result: ResultReference | null };
export type RequesterQuery = Omit<ProjectQuery, 'critics'> & { critics: RequesterCritic[]; results: RequesterResult[] };
export type RequesterPlan = Omit<ProjectPlan, 'critics' | 'items'> & { critics: RequesterCritic[]; items: (RequesterCritic & Pick<ProjectPlan['items'][number], 'action' | 'leaseExpiresAt'>)[]; results: RequesterResult[] };
export interface RequesterRun {
  id: string; status: RunView['status']; workspaceIntegrity: 'content' | 'metadata';
  reference: ReviewReference; results: RequesterResult[];
  requests: (Omit<RequesterRequest, 'result'> & { result: ResultReference | null })[];
  validation?: Omit<RequesterPlan, 'results'>; error?: string;
}

export const reviewReference = (stateDir: string, runId: string, requestId: string | null): ReviewReference => ({ runId, requestId, stateDir: resolve(stateDir) });

/** Whitelists deliberately keep new audit fields out of requester output. Never mutate stored evidence. */
export function requesterEvidence(evidence: ValidationEvidence, stateDir: string): RequesterResult {
  return { ...semanticResult(evidence.result), verdict: evidence.verdict,
    reference: reviewReference(stateDir, evidence.runId, evidence.requestId) };
}
export function requesterRequest(request: ReviewRequest, stateDir: string): RequesterRequest {
  const reference = reviewReference(stateDir, request.runId, request.id), inputKey = request.validationInput?.key ?? null;
  return { id: request.id, runId: request.runId, criticId: request.criticId, target: request.target, status: request.status,
    inputKey, reference, error: request.error, errorCode: request.errorCode, blockedReason: request.blockedReason,
    result: request.result ? { ...semanticResult(request.result), verdict: request.result.verdict, reference } : null };
}
function requesterCritic<T extends CriticValidation>(critic: T): Omit<T, 'input' | 'result'> & RequesterCritic {
  const { input, result, ...rest } = critic;
  return { ...rest, inputKey: input.key, result: result ? { requestId: result.requestId } : null };
}
export function requesterQuery(query: ProjectQuery, stateDir: string): RequesterQuery {
  return { ...query, critics: query.critics.map(critic => requesterCritic(critic)),
    results: uniqueResults(query.critics.flatMap(critic => critic.result ? [requesterEvidence(critic.result, stateDir)] : [])) };
}
export function requesterPlan(plan: ProjectPlan, stateDir: string): RequesterPlan {
  return { ...plan, ...requesterQuery(plan, stateDir), items: plan.items.map(critic => requesterCritic(critic)) };
}
export function requesterRun(run: Pick<RunView, 'id' | 'status' | 'workspace' | 'requests' | 'error'> & { validation?: ProjectPlan }, stateDir: string): RequesterRun {
  const requests = run.requests.map(request => requesterRequest(request, stateDir));
  const plan = run.validation ? requesterPlan(run.validation, stateDir) : undefined;
  const { results: validationResults = [], ...validation } = plan ?? {};
  return { id: run.id, status: run.status, workspaceIntegrity: run.workspace?.integrity ?? 'content',
    reference: reviewReference(stateDir, run.id, null), error: run.error,
    results: uniqueResults([...requests.flatMap(request => request.result ? [request.result] : []), ...validationResults]).map(result => result.reference.runId === run.id ? result : { ...result, reusedFrom: result.reference }),
    requests: requests.map(({ result, ...request }) => ({ ...request, result: result ? { requestId: request.id } : null })),
    ...(plan ? { validation: validation as Omit<RequesterPlan, 'results'> } : {}) };
}
function uniqueResults(results: RequesterResult[]): RequesterResult[] {
  return [...new Map(results.map(result => [result.reference.requestId, result])).values()];
}
export function resultView<D extends ResultDetail, Full, Compact>(options: ResultOptions<D>, full: Full, compact: () => Compact): ResultView<D, Full, Compact> {
  if (options.detail !== undefined && options.detail !== 'compact' && options.detail !== 'full') throw new Error('detail must be compact or full.');
  return (options.detail === 'full' ? full : compact()) as ResultView<D, Full, Compact>;
}
