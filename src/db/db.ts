import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

export type Row = Record<string, unknown>;

/** The only database surface the app uses, so PGlite and node-postgres are interchangeable. */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const DEFAULT_DATA_DIR = "./.data/pg";

export async function openDb(options: { databaseUrl?: string; dataDir?: string; inMemory?: boolean } = {}): Promise<Db> {
  const dataDir = options.inMemory ? undefined : (options.dataDir ?? DEFAULT_DATA_DIR);
  if (!options.databaseUrl && dataDir) await mkdir(dataDir, { recursive: true });
  const db = options.databaseUrl ? openPostgres(options.databaseUrl) : openPglite(dataDir);
  await db.query(SCHEMA_SQL);
  return db;
}

function openPglite(dataDir: string | undefined): Db {
  const client = new PGlite(dataDir);
  const wrap = (q: { query: PGlite["query"]; exec: PGlite["exec"] }): Db => ({
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      // exec() runs multi-statement SQL (the schema); query() runs one parameterised statement.
      if (params.length === 0 && sql.includes(";")) {
        await q.exec(sql);
        return [];
      }
      return (await q.query<T>(sql, params)).rows;
    },
    transaction: (fn) => client.transaction((tx) => fn(wrap(tx))),
    close: () => client.close(),
  });
  return wrap(client);
}

function openPostgres(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const wrap = (q: pg.Pool | pg.PoolClient): Db => ({
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await q.query(sql, params)).rows as T[];
    },
    async transaction(fn) {
      const conn = await pool.connect();
      try {
        await conn.query("begin");
        const result = await fn(wrap(conn));
        await conn.query("commit");
        return result;
      } catch (err) {
        await conn.query("rollback");
        throw err;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  });
  return wrap(pool);
}
