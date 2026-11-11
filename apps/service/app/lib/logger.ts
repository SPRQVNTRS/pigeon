import { createLogger, type Logger } from '@sprqvntrs/logger';
import { resolveServiceName } from '#app/config/deployment-settings';

/**
 * Application-wide logger instance.
 *
 * Uses @sprqvntrs/logger for structured logging with:
 * - Automatic redaction of sensitive fields
 * - Pretty printing in development
 * - JSON output in production
 */
export const logger = createLogger({
  serviceName: resolveServiceName(),
  level: (process.env.LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') || 'info',
});

/**
 * Create a child logger for a specific component/module.
 *
 * @example
 * const log = createComponentLogger('AuthService');
 * log.info('User logged in', { userId: '123' });
 */
export function createComponentLogger(component: string): Logger {
  return logger.child({ component });
}

export type { Logger };
