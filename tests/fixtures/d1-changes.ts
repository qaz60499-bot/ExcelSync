import type { DatabaseSync } from 'node:sqlite'

// D1 meta.changes includes trigger writes; StatementSync.run().changes does not.
export function totalChanges(db: DatabaseSync): number {
  return Number(db.prepare('SELECT total_changes() AS count').get()!.count)
}
