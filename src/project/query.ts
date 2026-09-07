import { createGraphDefinition } from '../broker/graph.js';
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

export function includedCritics(snapshot: ProjectSnapshot, selection: ProjectSelection, recursive: boolean): string[] {
  const included = new Set(selectedCritics(snapshot, selection));
  if (recursive || selection.kind === 'all') {
    const visit = (id: string): void => {
      const critic = snapshot.config.critics.find(c => c.id === id)!;
      for (const parent of snapshot.config.critics.filter(c => critic.deps.includes(c.target))) {
        if (included.has(parent.id)) continue;
        included.add(parent.id); visit(parent.id);
      }
    };
    for (const id of [...included]) visit(id);
  }
  return snapshot.config.critics.filter(c => included.has(c.id)).map(c => c.id);
}

/** No stored staleState: these memo tables live for precisely one pull query. */
export function queryProject(snapshot: ProjectSnapshot, history: readonly ValidationEvidence[], options: QueryOptions = {}): ProjectQuery {
  createGraphDefinition(snapshot.config);
  const selection = options.selection ?? { kind: 'all' };
  selectedCritics(snapshot, selection);
  const byKey = new Map<string, ValidationEvidence>(), byRunKey = new Map<string, ValidationEvidence>(), byCritic = new Map<string, ValidationEvidence>();
  // The store orders ties by insertion order. Stable sorting keeps that order here.
  for (const evidence of [...history].sort((a, b) => a.completedAt.localeCompare(b.completedAt))) {
    byKey.set(evidence.input.key, evidence); byCritic.set(evidence.criticId, evidence);
    if (evidence.runId === options.runId) byRunKey.set(evidence.input.key, evidence);
  }
  const attempts = new Map(options.attempts?.map(request => [request.criticId, request]));
  const forced = new Set(options.forceCriticIds ?? []);
  const artifactMemo = new Map<string, ArtifactValidation>(), criticMemo = new Map<string, CriticValidation>();
  const critic = (id: string): CriticValidation => {
    if (criticMemo.has(id)) return criticMemo.get(id)!;
    const definition = snapshot.config.critics.find(c => c.id === id)!;
    const input = snapshot.inputs[id];
    if (!input) throw new Error(`Missing recorded validation input: ${id}`);
    const found = (input.reusable && !forced.has(id) ? byKey : byRunKey).get(input.key);
    const attempt = attempts.get(id);
    const evidence = found && found.criticId === id && (input.reusable && !forced.has(id) || found.runId === options.runId) ? found : null;
    const blockedBy = definition.deps.filter(dep => artifact(dep).isStale);
    const ownPass = evidence?.verdict === 'GREEN';
    let status: ValidationStatus, reason: string;
    if (attempt && ['QUEUED', 'RUNNING', 'WAITING_HUMAN'].includes(attempt.status)) {
      status = attempt.status as ValidationStatus; reason = 'A review of this input is in progress.';
    } else if (attempt?.status === 'ERROR') {
      status = 'ERROR'; reason = attempt.error ?? 'The review could not complete.';
    } else if (blockedBy.length) {
      status = 'BLOCKED'; reason = `Required Artifact validation is not satisfied: ${blockedBy.map(dep => `${dep} (${artifact(dep).criticIds.filter(id => critic(id).isStale).map(id => `${id}: ${critic(id).status}`).join(', ') || 'no evaluator'})`).join('; ')}.`;
    } else if (ownPass) {
      status = 'PASS'; reason = `Reusing actual PASS evidence ${evidence!.requestId}.`;
    } else if (evidence?.verdict === 'RED') {
      status = 'RED'; reason = evidence.summary;
    } else if (forced.has(id)) {
      status = 'STALE'; reason = 'This request explicitly requires a new review.';
    } else if (!input.reusable) {
      status = 'STALE'; reason = 'The always strategy requires a review in this validation request.';
    } else if (byCritic.has(id)) {
      const previous = byCritic.get(id)!.input;
      const changed = [previous.criticHash !== input.criticHash ? 'Critic conditions' : '', previous.target.hash !== input.target.hash ? `target ${input.target.id}` : '', ...input.deps.filter(dep => previous.deps.find(p => p.id === dep.id)?.hash !== dep.hash).map(dep => `dependency ${dep.id}`)].filter(Boolean);
      status = 'STALE'; reason = `Validation input changed: ${changed.join(', ') || 'dependency scope'}.`;
    } else {
      status = 'UNREVIEWED'; reason = 'No actual review has been recorded for this input.';
    }
    const value: CriticValidation = { id, title: definition.title, target: definition.target, deps: [...definition.deps], status,
      isStale: status !== 'PASS', needsReview: !ownPass || forced.has(id) && evidence?.runId !== options.runId,
      canExecute: blockedBy.length === 0 && !ownPass && !attempt,
      blockedBy, reason, input, result: evidence, requestId: attempt?.id ?? null };
    criticMemo.set(id, value); return value;
  };
  const artifact = (id: string): ArtifactValidation => {
    if (artifactMemo.has(id)) return artifactMemo.get(id)!;
    const definition = snapshot.config.artifacts[id];
    const own = snapshot.config.critics.filter(c => c.target === id).map(c => critic(c.id));
    const passed = own.filter(c => !c.isStale).length;
    const status: ValidationStatus = definition.basis ? 'BASIS' : own.length && passed === own.length ? 'PASS' :
      (['RUNNING', 'QUEUED', 'WAITING_HUMAN', 'ERROR', 'RED', 'BLOCKED', 'STALE', 'UNREVIEWED'] as const).find(s => own.some(c => c.status === s)) ?? 'UNREVIEWED';
    const value: ArtifactValidation = { id, hash: snapshot.artifactHashes[id], status, isStale: status !== 'PASS' && status !== 'BASIS', criticIds: own.map(c => c.id), passed, total: own.length };
    artifactMemo.set(id, value); return value;
  };
  const artifacts = Object.keys(snapshot.config.artifacts).map(artifact);
  const critics = snapshot.config.critics.map(c => critic(c.id));
  const satisfied = selection.kind === 'artifact' ? !artifact(selection.artifactId).isStale : selection.kind === 'critic' ? !critic(selection.criticId).isStale : critics.every(c => !c.isStale);
  return { snapshotHash: snapshot.snapshotHash, selection, satisfied, artifacts, critics };
}

export function planProject(snapshot: ProjectSnapshot, history: readonly ValidationEvidence[], options: QueryOptions & { recursive?: boolean; force?: boolean } = {}): ProjectPlan {
  const selection = options.selection ?? { kind: 'all' };
  const selectedCriticIds = selectedCritics(snapshot, selection);
  const includedCriticIds = includedCritics(snapshot, selection, Boolean(options.recursive));
  const forceCriticIds = options.force ? selectedCriticIds : [];
  const query = queryProject(snapshot, history, { ...options, selection, forceCriticIds });
  const items = query.critics.filter(c => includedCriticIds.includes(c.id)).map(c => {
    const action = (c.status === 'PASS' ? 'REUSE' : ['QUEUED', 'RUNNING', 'WAITING_HUMAN'].includes(c.status) ? 'ACTIVE' : c.canExecute ? 'EXECUTE' : c.requestId && ['ERROR', 'RED'].includes(c.status) ? 'FAILED' : 'WAIT') as ProjectPlan['items'][number]['action'];
    return { ...c, action };
  });
  return { ...query, recursive: Boolean(options.recursive), force: Boolean(options.force), selectedCriticIds, includedCriticIds, items,
    counts: { reuse: items.filter(c => c.action === 'REUSE').length, execute: items.filter(c => c.action === 'EXECUTE').length, wait: items.filter(c => c.action === 'WAIT').length, active: items.filter(c => c.action === 'ACTIVE').length, failed: items.filter(c => c.action === 'FAILED').length } };
}
