import { resolve } from 'node:path';
import { identityCacheDirectory, openIdentityCache, readIdentityCache } from './index.js';
import { cachedResultView, compareIdentityCache, listIdentityCache } from './query.js';

/** Cache commands intentionally do not resolve a project or require an existing workspace. */
export async function cacheCommand(argv: string[], output: { write(text: string): unknown }): Promise<number> {
  const [command, ...args] = argv, positional: string[] = [], options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { if (options.has(arg)) throw new Error('Duplicate --json.'); options.set(arg, 'true'); }
    else if (['--cache-dir', '--after', '--limit'].includes(arg)) {
      if (options.has(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid or duplicate ${arg}.`);
      options.set(arg, args[++i]);
    } else if (arg.startsWith('-')) throw new Error(`Unknown cache option: ${arg}`);
    else positional.push(arg);
  }
  const directory = options.has('--cache-dir') ? resolve(options.get('--cache-dir')!) : identityCacheDirectory();
  const print = (value: unknown) => output.write(JSON.stringify(value, null, 2) + '\n');
  if (!['show', 'list', 'compare', 'gc', 'delete'].includes(command)) throw new Error('Use cache show ID, list, compare LEFT RIGHT, gc, or delete ID.');
  if (options.has('--after') && command !== 'list' || options.has('--limit') && !['list', 'gc'].includes(command)) throw new Error('Cache pagination options do not apply to this command.');
  const expected = command === 'compare' ? 2 : ['show', 'delete'].includes(command) ? 1 : 0;
  if (positional.length !== expected) throw new Error(`cache ${command} requires ${expected} positional arguments.`);
  const limit = options.has('--limit') ? Number(options.get('--limit')) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new Error('Cache limit must be 1-1000.');
  if (command === 'show') { const entry = readIdentityCache(positional[0], directory); print(entry ? cachedResultView(entry) : null); return entry ? 0 : 4; }
  if (command === 'list') { print(listIdentityCache({ directory, after: options.get('--after'), limit })); return 0; }
  if (command === 'compare') { const result = compareIdentityCache(positional[0], positional[1], directory); print(result); return result.left && result.right ? 0 : 4; }
  const cache = openIdentityCache({ directory });
  try { print(command === 'gc' ? await cache.gc({ limit }) : { removed: await cache.delete(positional[0]) }); return 0; }
  finally { await cache.close(); }
}
