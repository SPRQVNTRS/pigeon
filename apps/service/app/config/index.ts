/**
 * Centralized Application Configuration
 *
 * Single source of truth for all environment variable access.
 *
 * Benefits:
 * - Type-safe configuration access throughout the application
 * - Single place to see all environment variable requirements
 * - Runtime validation with clear error messages
 * - Easy to mock for testing
 * - Clear separation of concerns: environment config vs domain config vs constants
 *
 * Usage:
 * ```typescript
 * import { CONFIG } from '#app/config';
 *
 * const port = CONFIG.server.port;
 * const isProduction = CONFIG.app.isProduction;
 * ```
 */

import { requireEnv, optionalEnv, optionalBoolEnv, optionalIntEnv } from '@sprqvntrs/helpers';
import { parseInboundSnsTopicArn } from './inbound';
import { parseDmarcSnsTopicArn } from './dmarc';
import { parseSesSnsTopicArn } from './ses';
import { resolveDmarcRua } from './deployment-settings';

export const CONFIG = {
  /**
   * Application Environment
   */
  app: {
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
    isTest: process.env.NODE_ENV === 'test',
    url: optionalEnv('APP_URL', 'http://localhost:3601'),
  },

  /**
   * Server Configuration
   */
  server: {
    port: optionalIntEnv('PORT', 3601),
    hmrPort: optionalIntEnv('HMR_PORT', 24678),
  },

  /**
   * Database Configuration
   */
  database: {
    host: optionalEnv('DB_HOST', 'localhost'),
    port: optionalIntEnv('DB_PORT', 5432),
    user: optionalEnv('DB_USER', 'postgres'),
    password: optionalEnv('DB_PASSWORD', 'postgres'),
    name: optionalEnv('DB_NAME', 'email_service'),
    ssl: optionalBoolEnv('DB_SSL', false),
    get url() {
      return `postgres://${this.user}:${this.password}@${this.host}:${this.port}/${this.name}`;
    },
    pool: {
      max: optionalIntEnv('DB_POOL_MAX', 10),
      min: optionalIntEnv('DB_POOL_MIN', 2),
      idleTimeoutMillis: optionalIntEnv('DB_IDLE_TIMEOUT_MS', 30000),
      connectionTimeoutMillis: optionalIntEnv('DB_CONNECTION_TIMEOUT_MS', 5000),
    },
  },

  /**
   * Session Configuration
   */
  session: {
    get secret() {
      return CONFIG.app.isProduction ? requireEnv('SESSION_SECRET') : 's3cr3t';
    },
  },

  /**
   * Superadmin Configuration
   */
  superadmin: {
    email: optionalEnv('SUPERADMIN_EMAIL', 'superadmin@example.com'),
    password: optionalEnv('SUPERADMIN_PASSWORD', 'password'),
  },

  /**
   * Logging Configuration
   */
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
  },

  /**
   * Feature Flags
   */
  features: {
    debugMode: optionalBoolEnv('DEBUG_MODE', false),
  },

  /**
   * AWS / SES Configuration
   *
   * All optional with placeholder defaults — real values provided via environment
   * variables in production.
   */
  aws: {
    region: optionalEnv('AWS_REGION', 'eu-central-1'),
    accessKeyId: optionalEnv('AWS_ACCESS_KEY_ID', ''),
    secretAccessKey: optionalEnv('AWS_SECRET_ACCESS_KEY', ''),
    sesFromAddress: optionalEnv('AWS_SES_FROM_ADDRESS', 'noreply@example.com'),
    sesConfigSet: optionalEnv('AWS_SES_CONFIG_SET', 'pigeon'),
    /** Centralized DMARC aggregate reporting inbox. Set PIGEON_DMARC_RUA in env; undefined while unset. */
    dmarcRua: resolveDmarcRua(),
  },

  /**
   * SES delivery, bounce and complaint events (SES → SNS → POST /v1/webhooks/ses).
   * Off while SES_SNS_TOPIC_ARN is unset: the route answers 503.
   */
  sesEvents: {
    snsTopicArn: parseSesSnsTopicArn(process.env.SES_SNS_TOPIC_ARN),
  },

  /**
   * Inbound mail (SES receiving → S3 → SNS → POST /v1/webhooks/inbound).
   * Off while INBOUND_SNS_TOPIC_ARN is unset.
   */
  inbound: {
    snsTopicArn: parseInboundSnsTopicArn(process.env.INBOUND_SNS_TOPIC_ARN),
  },

  /**
   * DMARC aggregate reports (SES receiving -> S3 -> SNS -> POST /v1/webhooks/dmarc).
   * Off while DMARC_SNS_TOPIC_ARN is unset.
   */
  dmarc: {
    snsTopicArn: parseDmarcSnsTopicArn(process.env.DMARC_SNS_TOPIC_ARN),
  },
} as const;

export type Config = typeof CONFIG;
