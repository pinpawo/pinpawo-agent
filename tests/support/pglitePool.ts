import { PGlite } from '@electric-sql/pglite';
import type { PostgresPool, PostgresPoolClient, PostgresQueryResult } from 'kysely';

/**
 * An in-process Postgres (PGlite) behind the pool interface Kysely's Postgres
 * dialect uses, so storage tests run against real Postgres SQL without a
 * server. PGlite has one session, so clients are handed out one at a time.
 */
export function createPglitePool(): PostgresPool {
  const database = new PGlite();
  let queue = Promise.resolve();
  async function query<R>(sql: string, parameters: ReadonlyArray<unknown>): Promise<PostgresQueryResult<R>> {
    const result = await database.query<R>(sql, [...parameters]);
    const command = sql.trimStart().split(/\s/, 1)[0]!.toUpperCase() as PostgresQueryResult<R>['command'];
    return { command, rowCount: result.affectedRows ?? result.rows.length, rows: result.rows };
  }
  // Streaming (the cursor form of query) is not used by the stores under test.
  const client = (release: () => void) => ({ query, release }) as PostgresPoolClient;
  return {
    options: {},
    connect() {
      let release!: () => void;
      const turn = new Promise<void>((resolve) => { release = resolve; });
      const acquired = queue.then(() => client(release));
      queue = queue.then(() => turn);
      return acquired;
    },
    end: () => database.close(),
  };
}
