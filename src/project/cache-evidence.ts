import { identityCacheDirectory, readIdentityEntries, readActiveIdentities, type CacheEntry } from '../cache/index.js';
import type { ExecutionSource } from '../contracts.js';
import type { ProjectSnapshot, ValidationEvidence } from './types.js';
import { diagnosticScope } from '../diagnostic-scope.js';

export function snapshotCache(snapshot: ProjectSnapshot, directory = identityCacheDirectory()) {
  // Offline load tests must never consume or publish production evidence.
  if (diagnosticScope.getStore()) return new Map<string, CacheEntry>();
  return readIdentityEntries(Object.values(snapshot.inputs).flatMap(input => input.version === 4 && input.cacheIdentity ? [input.cacheIdentity] : []), directory);
}
export function cacheSource(entry: CacheEntry): ExecutionSource | undefined {
  return entry.identity && entry.value.origin.stateDir ? { ...entry.value.origin, stateDir: entry.value.origin.stateDir, identity: entry.identity, executionId: entry.executionId } : undefined;
}
export function cacheEvidence(snapshot: ProjectSnapshot, entries = snapshotCache(snapshot)): ValidationEvidence[] {
  return Object.entries(snapshot.inputs).flatMap(([criticId, input]) => {
    const entry = input.cacheIdentity ? entries.get(input.cacheIdentity) : undefined;
    return entry ? [{ requestId: entry.value.origin.requestId, runId: entry.value.origin.runId, criticId, input,
      completedAt: entry.completedAt, verdict: entry.value.result.verdict, result: entry.value.result,
      executionProvenance: entry.value.executionProvenance, source: cacheSource(entry), profile: entry.value.profile, cacheLookup: true }] : [];
  });
}

export function snapshotActive(snapshot: ProjectSnapshot) {
  return diagnosticScope.getStore() ? new Map<string,string>() : readActiveIdentities(Object.values(snapshot.inputs).flatMap(input => input.version === 4 && input.cacheIdentity ? [input.cacheIdentity] : []));
}
