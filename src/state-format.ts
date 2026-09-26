import type { DatabaseSync } from 'node:sqlite';

export class StateFormatError extends Error {
  constructor() { super('This state directory was created by an earlier CCDD major or an unsupported format; use a new state directory.'); }
}

/** No legacy reads or migrations: all entry points use the same format gate. */
export function assertStateFormat(database: DatabaseSync): void {
  if (database.prepare('PRAGMA user_version').get()?.user_version !== 6) throw new StateFormatError();
}

/** Called inside the initialization transaction, before creating any tables. */
export function initializeStateFormat(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  const existing = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
  if (version === 0 && !existing) database.exec('PRAGMA user_version=6');
  else assertStateFormat(database);
}
