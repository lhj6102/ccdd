import type { DatabaseSync } from 'node:sqlite';
import type { ReviewStatus, RunStatus } from '../contracts.js';

/** Scheduling invalidation is operational state, never Artifact/reuse identity. */
export function createStatusPolling(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduling_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO scheduling_revision VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS scheduling_request_insert AFTER INSERT ON requests BEGIN
      UPDATE scheduling_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS scheduling_request_delete AFTER DELETE ON requests BEGIN
      UPDATE scheduling_revision SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS scheduling_request_status AFTER UPDATE OF status ON requests WHEN OLD.status != NEW.status BEGIN
      UPDATE scheduling_revision SET revision = revision + 1 WHERE id = 1;
    END;
  `);
  const run = db.prepare('SELECT status FROM runs WHERE id = ?');
  const requests = db.prepare('SELECT id, status FROM requests WHERE run_id = ? ORDER BY ordinal');
  const revision = db.prepare('SELECT revision FROM scheduling_revision WHERE id = 1');
  return {
    runStatus: (id: string) => (run.get(id) as { status: RunStatus } | undefined)?.status,
    requests: (id: string) => requests.all(id) as unknown as { id: string; status: ReviewStatus }[],
    revision: () => Number(revision.get()!.revision),
  };
}
