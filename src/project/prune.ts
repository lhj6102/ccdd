import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readStateContext } from '../broker/index.js';

export interface PruneResult { removed: string[]; skippedRequests: string[] }
const terminal = new Set(['GREEN', 'RED', 'ERROR', 'INCOMPLETE']);
const segment = (value: string) => value !== '.' && value !== '..' && /^[A-Za-z0-9_-]+$/.test(value);
const transient = (name: string) => ['output', 'tmp', 'home', 'cache', 'human-tools', 'preparation'].includes(name) || /^tool-output-[A-Za-z0-9]+$/.test(name);

/** Explicit, conservative pruning: no automatic policy and no audit table/file deletion. */
export function pruneProject(stateDir: string): PruneResult {
  const context = readStateContext(stateDir), root = context.stateDir;
  const relation = relative(context.repoPath, root);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..')) throw new Error('Pruning requires state outside the reviewed repository.');
  const db = new DatabaseSync(join(root, 'broker.sqlite'), { timeout: 5000 });
  const result: PruneResult = { removed: [], skippedRequests: [] };
  // Exclude new ownership/claim transitions until deletion finishes. Running or
  // waiting requests and any run with a monitoring owner are never candidates.
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare('SELECT q.id, q.run_id, q.status, r.status AS run_status, o.run_id AS owned FROM requests q JOIN runs r ON r.id = q.run_id LEFT JOIN run_owners o ON o.run_id = r.id').all();
    for (const row of rows) {
      const id = String(row.id), runId = String(row.run_id);
      if (!terminal.has(String(row.status)) || !terminal.has(String(row.run_status)) || row.owned != null || !segment(id) || !segment(runId)) { result.skippedRequests.push(id); continue; }
      const parents = [join(root, 'runs'), join(root, 'runs', runId), join(root, 'runs', runId, id)];
      // Never traverse a symlink, even when it currently points inside state.
      const safe = parents.every(parent => {
        try { return lstatSync(parent).isDirectory() && realpathSync(parent) === parent; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      });
      if (!safe) continue;
      const requestDir = parents[2];
      for (const name of readdirSync(requestDir)) {
        if (!transient(name)) continue;
        const target = join(requestDir, name);
        // rm unlinks a leaf symlink rather than following its target.
        rmSync(target, { recursive: true, force: true });
        result.removed.push(relative(root, target));
      }
    }
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
