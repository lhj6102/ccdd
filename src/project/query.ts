import { createGraphDefinition } from '../broker/graph.js';
import { dependencyClosure } from '../artifacts/scope.js';
import type { ProjectSnapshot, ProjectSelection, QueryOptions, ValidationEvidence, ArtifactValidation, CriticValidation, ProjectQuery, ProjectPlan, ValidationStatus } from './types.js';

export function selectedCritics(snapshot: ProjectSnapshot, selection: ProjectSelection): string[] {
  const config = snapshot.config;
  if (selection.kind === 'all') return config.critics.map(c => c.id);
  if (selection.kind === 'critic') {
    if (!config.critics.some(c => c.id === selection.criticId)) throw new Error(`Unknown Critic: ${selection.criticId}`);
    return [selection.criticId];
  }
  if (!Object.hasOwn(config.artifacts, selection.artifactId)) throw new Error(`Unknown Artifact: ${selection.artifactId}`);
  return config.critics.filter(c => c.target === selection.artifactId).map(c => c.id);
}

export function requiredArtifacts(snapshot: ProjectSnapshot, selection: ProjectSelection): string[] {
  selectedCritics(snapshot, selection);
  const roots = selection.kind === 'all' ? Object.keys(snapshot.config.artifacts) : selection.kind === 'artifact' ? [selection.artifactId] : [snapshot.config.critics.find(c => c.id === selection.criticId)!.target];
  return dependencyClosure(snapshot.config.relations, roots);
}

export function includedCritics(snapshot: ProjectSnapshot, selection: ProjectSelection, recursive: boolean): string[] {
  const selected = selectedCritics(snapshot, selection);
  if (!recursive && selection.kind !== 'all') return selected;
  const scope = new Set(requiredArtifacts(snapshot, selection));
  return snapshot.config.critics.filter(c => scope.has(c.target)).map(c => c.id);
}

/** Pull actual evidence once; dependency traversal never calls back into Critic evaluation. */
export function queryProject(snapshot: ProjectSnapshot, history: readonly ValidationEvidence[], options: QueryOptions = {}): ProjectQuery {
  if (snapshot.version !== 2) throw new Error('Historical validation inputs are available for result lookup only.');
  createGraphDefinition(snapshot.config);
  const selection = options.selection ?? { kind: 'all' }, required = requiredArtifacts(snapshot, selection);
  const byKey = new Map<string, ValidationEvidence>(), byRunKey = new Map<string, ValidationEvidence>(), byCritic = new Map<string, ValidationEvidence>();
  for (const evidence of [...history].filter(e => e.input.version === 2).sort((a, b) => a.completedAt.localeCompare(b.completedAt))) {
    const key = `${evidence.criticId}:${evidence.input.key}`;
    byKey.set(key, evidence); byCritic.set(evidence.criticId, evidence);
    if (evidence.runId === options.runId) byRunKey.set(key, evidence);
  }
  const attempts = new Map(options.attempts?.map(request => [request.criticId, request])), forced = new Set(options.forceCriticIds ?? []);
  const critics: CriticValidation[] = snapshot.config.critics.map(definition => {
    const id = definition.id, input = snapshot.inputs[id];
    if (!input || input.version !== 2) throw new Error(`Missing current validation input: ${id}`);
    const key = `${id}:${input.key}`, evidence = (input.reusable && !forced.has(id) ? byKey : byRunKey).get(key) ?? null;
    const attempt = attempts.get(id), ownPass = evidence?.verdict === 'GREEN';
    let status: ValidationStatus, reason: string;
    if (attempt && ['QUEUED', 'RUNNING', 'WAITING_HUMAN'].includes(attempt.status)) {
      status = attempt.status as ValidationStatus; reason = 'A review of this input is in progress.';
    } else if (attempt?.status === 'ERROR') {
      status = 'ERROR'; reason = attempt.error ?? 'The review could not complete.';
    } else if (ownPass) { status = 'PASS'; reason = `Actual PASS evidence ${evidence!.requestId} matches this input.`; }
    else if (evidence?.verdict === 'RED') { status = 'RED'; reason = evidence.summary; }
    else if (forced.has(id)) { status = 'STALE'; reason = 'This request explicitly requires a new review.'; }
    else if (!input.reusable) { status = 'STALE'; reason = 'The always strategy requires a review in this validation request.'; }
    else if (byCritic.has(id)) { status = 'STALE'; reason = 'Artifact content, referenced inputs, or Critic conditions changed.'; }
    else { status = 'UNREVIEWED'; reason = 'No actual review has been recorded for this input.'; }
    return { id, title: definition.title, target: definition.target, deps: [...definition.deps], status, isStale: status !== 'PASS', needsReview: !ownPass,
      canExecute: !ownPass && !attempt, blockedBy: [], reason, input, result: evidence, requestId: attempt?.id ?? null };
  });
  const own = new Map<string, CriticValidation[]>(Object.keys(snapshot.config.artifacts).map(id => [id, critics.filter(c => c.target === id)]));
  const ownSatisfied = (id: string) => snapshot.config.artifacts[id].basis === true || own.get(id)!.length > 0 && own.get(id)!.every(c => c.status === 'PASS');
  const scopeMemo = new Map<string, string[]>();
  const scope = (id: string) => { if (!scopeMemo.has(id)) scopeMemo.set(id, dependencyClosure(snapshot.config.relations, [id])); return scopeMemo.get(id)!; };
  const artifacts = Object.keys(snapshot.config.artifacts).map((id): ArtifactValidation => {
    const evaluations = own.get(id)!, satisfied = scope(id).every(ownSatisfied);
    const status: ValidationStatus = satisfied ? snapshot.config.artifacts[id].basis ? 'BASIS' : 'PASS' :
      (['RUNNING', 'QUEUED', 'WAITING_HUMAN', 'ERROR', 'RED', 'STALE', 'UNREVIEWED'] as const).find(s => evaluations.some(c => c.status === s)) ?? (ownSatisfied(id) ? 'INCOMPLETE' : 'UNREVIEWED');
    return { id, hash: snapshot.artifactHashes[id], ...snapshot.artifactIdentities?.[id], status, isStale: !satisfied, criticIds: evaluations.map(c => c.id), passed: evaluations.filter(c => c.status === 'PASS').length, total: evaluations.length };
  });
  // These are unmet final obligations, not reasons to delay executing a Critic.
  for (const critic of critics) critic.blockedBy = scope(critic.target).filter(id => id !== critic.target && !ownSatisfied(id));
  return { snapshotHash: snapshot.snapshotHash, workspaceIntegrity: snapshot.workspaceIntegrity ?? 'content', selection, satisfied: required.every(ownSatisfied), artifacts, critics };
}

export function planProject(snapshot: ProjectSnapshot, history: readonly ValidationEvidence[], options: QueryOptions & { recursive?: boolean; force?: boolean } = {}): ProjectPlan {
  const selection = options.selection ?? { kind: 'all' }, selectedCriticIds = selectedCritics(snapshot, selection), includedCriticIds = includedCritics(snapshot, selection, Boolean(options.recursive));
  const query = queryProject(snapshot, history, { ...options, selection, forceCriticIds: options.force ? selectedCriticIds : options.forceCriticIds });
  const items = query.critics.filter(c => includedCriticIds.includes(c.id)).map(c => {
    const action = (c.status === 'PASS' ? 'REUSE' : ['QUEUED', 'RUNNING', 'WAITING_HUMAN'].includes(c.status) ? 'ACTIVE' : c.canExecute ? 'EXECUTE' : c.requestId ? 'FAILED' : 'WAIT') as ProjectPlan['items'][number]['action'];
    return { ...c, action };
  });
  return { ...query, recursive: Boolean(options.recursive), force: Boolean(options.force), selectedCriticIds, includedCriticIds, items,
    counts: { reuse: items.filter(c => c.action === 'REUSE').length, execute: items.filter(c => c.action === 'EXECUTE').length, wait: items.filter(c => c.action === 'WAIT').length, active: items.filter(c => c.action === 'ACTIVE').length, failed: items.filter(c => c.action === 'FAILED').length } };
}
