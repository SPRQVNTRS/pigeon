if (process.env.NODE_ENV !== 'production') {
  await import('dotenv/config');
}
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const LOCK_ID = 920328; // advisory lock ID for pigeon migrations

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1)', [LOCK_ID]);
  if (!rows[0].pg_try_advisory_lock) {
    console.log('Another instance is running migrations, skipping...');
  } else {
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: './drizzle/migrations' });
      console.log('Migrations applied successfully');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  }
} finally {
  client.release();
  await pool.end();
}
