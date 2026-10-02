import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { identityCacheDirectory, readIdentityCache, type CacheEntry } from './index.js';
import { semanticResult } from '../response-schema.js';

export interface CachePageOptions { directory?: string; after?: string; limit?: number }
/** Metadata pages are bounded and read-only, even when the cache has never existed. */
export function listIdentityCache({ directory = identityCacheDirectory(), after = '', limit = 100 }: CachePageOptions = {}) {
  if (typeof after !== 'string' || after.length > 128 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Cache page requires a cursor no longer than 128 characters and limit 1-1000.');
  const empty = { items: [] as { identity: string; bytes: number; createdAt: number; accessedAt: number }[], cursor: after, hasMore: false };
  const filename = join(directory, 'cache.sqlite'); if (!existsSync(filename)) return empty;
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try {
    db.exec('BEGIN');
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 1 || Number(db.prepare('PRAGMA application_id').get()!.application_id) !== 1128481859) throw new Error('Unsupported identity cache format.');
    const rows = db.prepare('SELECT identity,bytes,created_at,accessed_at FROM cache_entries WHERE identity>? ORDER BY identity LIMIT ?').all(after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ identity: String(row.identity), bytes: Number(row.bytes), createdAt: Number(row.created_at), accessedAt: Number(row.accessed_at) }));
    db.exec('COMMIT');
    return { items, cursor: items.at(-1)?.identity ?? after, hasMore: rows.length > limit };
  } finally { db.close(); }
}
/** The result's original execution is attribution, not a new cache eligibility rule. */
export function cachedResultView(entry: CacheEntry) {
  return { identity: entry.identity, executionId: entry.executionId, completedAt: entry.completedAt,
    result: semanticResult(entry.value.result), profile: structuredClone(entry.value.profile),
    origin: structuredClone(entry.value.origin), attemptId: entry.value.attemptId,
    executionProvenance: structuredClone(entry.value.executionProvenance), digest: entry.digest,
    usageState: entry.value.usage === undefined ? 'unreported' as const : 'reported' as const,
    ...(entry.value.usage === undefined ? {} : { usage: structuredClone(entry.value.usage) }),
  };
}
/** Comparison is informational; it does not invalidate, rerun or replace either entry. */
export function compareIdentityCache(left: string, right: string, directory = identityCacheDirectory()) {
  const a = readIdentityCache(left, directory), b = readIdentityCache(right, directory);
  return { left: a ? cachedResultView(a) : null, right: b ? cachedResultView(b) : null,
    differences: a && b ? {
      identity: a.identity !== b.identity,
      execution: a.executionId !== b.executionId,
      result: !isDeepStrictEqual(semanticResult(a.value.result), semanticResult(b.value.result)),
      profile: !isDeepStrictEqual(a.value.profile, b.value.profile),
      provenance: !isDeepStrictEqual(a.value.executionProvenance, b.value.executionProvenance),
    } : null,
  };
}
