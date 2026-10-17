import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny database abstraction over two drivers sharing one SQL dialect (PostgreSQL):
 *   - `pg`      production (managed Postgres: Supabase, Neon, Railway, RDS ...)
 *   - PGlite    embedded WASM Postgres for local development and automated tests (persists to disk)
 */

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  url?: string;
  ssl?: 'require' | 'no-verify' | 'disable';
  /** PGlite storage directory. `memory://` for ephemeral. */
  dataDir?: string;
}

export async function createDb(opts: DbOptions): Promise<Db> {
  if (opts.url) return createPgDb(opts.url, opts.ssl);
  return createPgliteDb(opts.dataDir ?? 'memory://');
}

async function createPgDb(url: string, ssl?: DbOptions['ssl']): Promise<Db> {
  const { default: pg } = await import('pg');
  const sslOpt = ssl === 'disable' ? false : ssl === 'no-verify' ? { rejectUnauthorized: false } : ssl === 'require' ? { rejectUnauthorized: true } : undefined;
  const pool = new pg.Pool({ connectionString: url, max: 6, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: sslOpt });
  pool.on('error', () => {
    /* idle client errors are surfaced on next query */
  });
  const wrap = (c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Queryable => ({
    async query(sql, params) {
      return (await c.query(sql, params as unknown[])).rows as any[];
    },
    async exec(sql) {
      await c.query(sql);
    },
  });
  return {
    kind: 'pg',
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (!dataDir.startsWith('memory://')) fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;
  // Serialise access: PGlite is single-connection.
  let chain: Promise<unknown> = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  const wrap = (c: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>; exec: (sql: string) => Promise<unknown> }, locked: boolean): Queryable => ({
    query: (sql, params) => (locked ? lock(async () => (await c.query(sql, params as unknown[])).rows as any[]) : c.query(sql, params as unknown[]).then((r) => r.rows as any[])),
    exec: (sql) => (locked ? lock(async () => void (await c.exec(sql))) : c.exec(sql).then(() => undefined)),
  });
  return {
    kind: 'pglite',
    ...wrap(db as any, true),
    tx: (fn) =>
      lock(() =>
        db.transaction(async (tx) => fn(wrap(tx as any, false))),
      ),
    async close() {
      await chain.catch(() => {});
      await db.close();
    },
  };
}

// ---------------- migrations ----------------

export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, '../../migrations'), // src/db -> apps/server/migrations
    path.resolve(here, '../migrations'), // dist -> apps/server/migrations
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(process.cwd(), 'apps/server/migrations'),
  ].filter(Boolean) as string[];
  const found = candidates.find((d) => fs.existsSync(d));
  if (!found) throw new Error(`Migrations directory not found (looked in: ${candidates.join(', ')})`);
  return found;
}

export async function migrate(db: Db, dir = defaultMigrationsDir()): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (id) VALUES ($1)', [f]);
    });
    ran.push(f);
  }
  return ran;
}
