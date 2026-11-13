import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

/** Persistent, atomic single-use grants. No credentials or raw tokens are stored. */
export class ReplayStore {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS consumed (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
    )
  }
  consume(token: string, expires: number): boolean {
    this.db
      .prepare('DELETE FROM consumed WHERE expires <= ?')
      .run(Math.floor(Date.now() / 1000))
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO consumed VALUES (?, ?)')
        .run(createHash('sha256').update(token).digest('hex'), expires)
        .changes === 1
    )
  }
  close() {
    this.db.close()
  }
}
