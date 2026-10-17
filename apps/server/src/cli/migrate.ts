import path from 'node:path';
import { loadConfig } from '../config';
import { createDb, migrate } from '../db/db';

/** `npm run db:migrate` — applies pending SQL migrations to DATABASE_URL (or the embedded dev database). */
const cfg = loadConfig();
const db = await createDb({ url: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, dataDir: path.join(cfg.DATA_DIR, 'pglite') });
const ran = await migrate(db);
process.stdout.write(ran.length ? `Applied migrations: ${ran.join(', ')}\n` : 'Database is up to date.\n');
await db.close();
