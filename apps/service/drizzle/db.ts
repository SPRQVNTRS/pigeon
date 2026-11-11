import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';
import { CONFIG } from '#config';
import { createServerLogger } from '@sprqvntrs/logger/server';

const { logger } = createServerLogger({ serviceName: 'database' });

/**
 * True once initializePool() has verified a successful connection.
 * Healthcheck returns 200 {status:'starting'} while this is false so Docker
 * StartPeriod transients do not trigger an unhealthy rollback.
 */
export let isPoolReady = false;

/**
 * Database Connection Pool
 *
 * Uses pg.Pool for connection pooling instead of a single client connection.
 * Pool settings are configured via environment variables (see CONFIG.database.pool).
 */
export const pool = new pg.Pool({
  connectionString: CONFIG.database.url,
  max: CONFIG.database.pool.max,
  min: CONFIG.database.pool.min,
  idleTimeoutMillis: CONFIG.database.pool.idleTimeoutMillis,
  connectionTimeoutMillis: CONFIG.database.pool.connectionTimeoutMillis,
  ssl: CONFIG.database.ssl ? { rejectUnauthorized: false } : undefined,
});

// Pool event monitoring
pool.on('connect', () => {
  logger.debug('New database connection established', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

pool.on('acquire', () => {
  logger.debug('Connection acquired from pool', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', { error: err });
});

pool.on('remove', () => {
  logger.debug('Connection removed from pool', {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
});

export const db = drizzle(pool, { schema });

// Keep client export for backward compatibility (uses pool internally)
export const client = pool;

/** Close the pool gracefully — call during shutdown. */
export async function closePool(): Promise<void> {
  await pool.end();
}

// Periodic pool stats logging (every 60 seconds) - only in production
if (CONFIG.app.isProduction) {
  setInterval(() => {
    const stats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    if (pool.waitingCount > 5) {
      logger.warn('Connection pool under pressure', stats);
    } else {
      logger.info('Connection pool stats', stats);
    }
  }, 60000);
}

/**
 * Initialize and verify database pool connection.
 *
 * Retries up to `maxAttempts` times with exponential backoff + ±20% jitter
 * before throwing the last caught error. Worst-case wait: ~61 s (6 attempts).
 */
export async function initializePool(maxAttempts = 6): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const testClient = await pool.connect();
      // Skip verbose logging in CLI mode
      if (!process.env.CLI_MODE) {
        logger.info('Database pool initialized successfully', {
          maxSize: CONFIG.database.pool.max,
          minSize: CONFIG.database.pool.min,
          idleTimeout: CONFIG.database.pool.idleTimeoutMillis,
          connectionTimeout: CONFIG.database.pool.connectionTimeoutMillis,
        });
      }
      testClient.release();
      isPoolReady = true;
      return;
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts - 1) {
        const baseDelay = Math.min(1000 * 2 ** attempt, 30000);
        const jitteredDelay = Math.floor(baseDelay * (0.8 + Math.random() * 0.4));
        logger.warn(
          `Database pool init attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${jitteredDelay}ms`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, jitteredDelay));
      }
    }
  }

  logger.error('Database pool initialization failed after all attempts', {
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  throw lastError;
}

initializePool().catch((err) => {
  logger.error('Database pool initialization failed permanently', { error: err instanceof Error ? err : String(err) });
  process.exit(1);
});
