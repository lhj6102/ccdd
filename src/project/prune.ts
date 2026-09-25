import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, lstatSync, readdirSync, rmSync, renameSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readStateContext } from '../broker/index.js';

export interface PruneResult { removed: string[]; skippedRequests: string[] }
/** Internal deterministic test seam; not exported by the project SDK. */
export const pruneTestHooks: { beforeMove?: (path: string) => void; beforeDelete?: () => void; removeQuarantine?: (path: string) => void } = {};
const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const segment = (value: string) => value !== '.' && value !== '..' && /^[A-Za-z0-9_-]+$/.test(value);
const transient = (name: string) => ['output', 'tmp', 'home', 'cache', 'human-tools', 'preparation'].includes(name) || /^tool-output-[A-Za-z0-9]+$/.test(name);
const anchor = (fd: number) => `/proc/self/fd/${fd}`;
const openDirectory = (path: string) => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Explicit Linux-only pruning with descriptor-anchored moves and private deletion. */
export function pruneProject(stateDir: string): PruneResult {
  if (process.platform !== 'linux') throw new Error('Explicit prune requires Linux /proc/self/fd for race-safe deletion. No files were removed.');
  const context = readStateContext(stateDir), root = context.stateDir;
  const relation = relative(context.repoPath, root);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..')) throw new Error('Pruning requires state outside the reviewed repository.');
  const rootFd = openDirectory(root);
  let db: DatabaseSync | undefined, quarantineFd: number | undefined, quarantineName: string | undefined;
  const result: PruneResult = { removed: [], skippedRequests: [] };
  const staged: { name: string; original: string }[] = [];
  let preserveQuarantine = false, failed = false;
  try {
    db = new DatabaseSync(join(anchor(rootFd), 'broker.sqlite'), { timeout: 5000 });
    db.exec('CREATE TABLE IF NOT EXISTS prune_claims (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
    const quarantine = mkdtempSync(join(anchor(rootFd), '.prune-'));
    chmodSync(quarantine, 0o700);
    quarantineName = quarantine.split('/').at(-1)!;
    quarantineFd = openDirectory(quarantine);
    const candidates = db.prepare('SELECT id, run_id FROM requests').all();
    for (const row of candidates) {
      const id = String(row.id), runId = String(row.run_id), fds: number[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const eligible = db.prepare('SELECT q.status, r.status AS run_status, o.run_id AS owned FROM requests q JOIN runs r ON r.id = q.run_id LEFT JOIN run_owners o ON o.run_id = r.id WHERE q.id = ?').get(id);
        if (!eligible || !terminal.has(String(eligible.status)) || !terminal.has(String(eligible.run_status)) || eligible.owned != null || !segment(id) || !segment(runId)) {
          result.skippedRequests.push(id);
        } else {
          // The private quarantine is the exclusive physical claim. Terminal runs
          // cannot reacquire a worker; active/owned runs are excluded under lock.
          db.prepare('INSERT OR IGNORE INTO prune_claims VALUES (?,?)').run(quarantineName, new Date().toISOString());
          try {
            let parent = rootFd;
            for (const part of ['runs', runId, id]) { parent = openDirectory(join(anchor(parent), part)); fds.push(parent); }
            for (const name of readdirSync(anchor(parent))) {
              if (!transient(name)) continue;
              const source = join(anchor(parent), name), before = lstatSync(source);
              const movedName = String(staged.length), destination = join(anchor(quarantineFd), movedName);
              pruneTestHooks.beforeMove?.(join(root, 'runs', runId, id, name));
              renameSync(source, destination);
              const moved = lstatSync(destination);
              if (before.dev !== moved.dev || before.ino !== moved.ino) {
                // Never overwrite a replacement at source or delete suspect data.
                preserveQuarantine = true;
                throw new Error(`Scratch entry changed during prune; preserved in ${join(root, quarantineName, movedName)}.`);
              }
              staged.push({ name: movedName, original: join('runs', runId, id, name) });
            }
          } catch (error) { if (!missing(error)) throw error; }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { for (const fd of fds.reverse()) closeSync(fd); }
    }
    // Recursive deletion holds no write transaction or broker lock.
    pruneTestHooks.beforeDelete?.();
    for (const entry of staged) {
      rmSync(join(anchor(quarantineFd), entry.name), { recursive: true, force: true });
      result.removed.push(entry.original);
    }
    return result;
  } catch (error) { failed = true; preserveQuarantine = true; throw error; }
  finally {
    let cleanupFailed = false, cleanupError: unknown;
    const cleanup = (action: () => void) => {
      try { action(); }
      catch (error) {
        if (!cleanupFailed) cleanupError = error;
        cleanupFailed = true; preserveQuarantine = true;
      }
    };
    // Each resource gets its own attempt. A cleanup error must neither strand
    // later resources nor replace an error from the operation itself.
    cleanup(() => { if (quarantineFd !== undefined) closeSync(quarantineFd); });
    cleanup(() => {
      if (!quarantineName || preserveQuarantine) return;
      const directory = join(anchor(rootFd), quarantineName);
      if (pruneTestHooks.removeQuarantine) pruneTestHooks.removeQuarantine(directory);
      else rmSync(directory, { recursive: true, force: true });
      db?.prepare('DELETE FROM prune_claims WHERE id = ?').run(quarantineName);
    });
    cleanup(() => { db?.close(); });
    cleanup(() => { closeSync(rootFd); });
    if (!failed && cleanupFailed) throw cleanupError;
  }
}
