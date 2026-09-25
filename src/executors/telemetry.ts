/** Safe Pi-reported counters only; absent usage never becomes invented zeroes. */
export function tokenUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens'].flatMap(key => {
    const count = (value as Record<string, unknown>)[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? [[key, count]] : [];
  }));
  return Object.keys(usage).length ? usage : undefined;
}


/** A diagnostic sink cannot hold an evaluation open or turn its result into ERROR. */
export async function bestEffortDiagnostic(write: () => void | Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(write).then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 100); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Allow only complete nonnegative payload counters, never arbitrary tool data. */
export function toolResponseBytes(value: Record<string, unknown>): Record<string, unknown> {
  const types = ['text', 'json', 'image', 'launch'];
  const counts = value.contentBytesByType;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return {};
  const byType = Object.fromEntries(types.map(type => [type, (counts as Record<string, unknown>)[type]]));
  if (!Object.values(byType).every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return {};
  const total = (Object.values(byType) as number[]).reduce((sum, bytes) => sum + bytes, 0);
  return Number.isSafeInteger(total) && total === value.contentBytes ? { contentBytes: total, contentBytesByType: byType } : {};
}
