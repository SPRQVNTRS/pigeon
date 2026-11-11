import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequestHandler } from '@react-router/express';
import express from 'express';
import compression from 'compression';
import { createServerLogger } from '@sprqvntrs/logger/server';
import { createHttpLogger } from '@sprqvntrs/logger/http';
import {
  initializeWorkflows,
  getOrchestrator,
  startWorkflowWorker,
  stopWorkflowWorker,
} from '#app/services/workflows.server';
import { registerScheduledTasks } from '#app/scheduled-tasks';
import { registerDomainVerifyWorker } from '#app/workflows/domain-verify';
import { registerEmailSendWorker } from '#app/workflows/email-send';
import { registerSesEventProcessWorker } from '#app/workflows/ses-event-process';
import {
  registerInboundWebhookDeliverWorker,
  registerWebhookDeliverWorker,
} from '#app/workflows/webhook-deliver';
import { registerInboundProcessWorker } from '#app/workflows/inbound-process';
import { registerDnsHealthCheckAdhocWorker } from '#app/workflows/dns-health-check';
import { closePool } from '#drizzle/db';
import {
  resolveDmarcRua,
  resolveRateLimitMode,
  resolveServiceName,
  resolveWebhookPrivateHosts,
  resolveWebhookPrivateTargets,
} from '#app/config/deployment-settings';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '.env') });

const { logger, logServerStart, logShutdown, logServerClosed } = createServerLogger({
  serviceName: resolveServiceName(),
  registerGlobalHandlers: true,
});

if (process.env.NODE_ENV === 'production' && !process.env.APP_URL) {
  throw new Error('APP_URL is not set');
}

// These are read again on each use; reading them here stops the boot on a bad
// value, instead of failing every request later.
logger.info('Security settings', {
  rateLimit: resolveRateLimitMode(),
  webhookPrivateTargets: resolveWebhookPrivateTargets(),
  webhookPrivateHosts: [...resolveWebhookPrivateHosts()],
});
logger.info('DMARC reports', { rua: resolveDmarcRua() ?? null });

const viteDevServer =
  process.env.NODE_ENV === 'production' ?
    undefined
  : await import('vite').then((vite) =>
      vite.createServer({
        server: { middlewareMode: true },
      }),
    );

// handle SSR requests

const remixHandler = createRequestHandler({
  build:
    viteDevServer ?
      () => viteDevServer.ssrLoadModule('virtual:react-router/server-build')
      // @ts-expect-error this file is generated at build time and relative to build directory
      // eslint-disable-next-line import/no-unresolved
    : await import('#build/server/index.js'),
});

const app = express();
app.use(compression());
app.disable('x-powered-by');

// handle asset requests
if (viteDevServer) {
  app.use(viteDevServer.middlewares);
} else {
  app.use(
    '/assets',
    express.static('build/client/assets', {
      immutable: true,
      maxAge: '1y',
    }),
  );
}

const httpLogger = createHttpLogger({
  logger,
  excludePaths: ['/healthcheck', '/healthz', '/__manifest', '/bullboard'],
  excludeExtensions: ['.ts', '.tsx', '.css', '.js', '.json', '.data', '.ico', '.png', '.svg'],
});

app.use(httpLogger);

// Remix fingerprints its assets so we can cache forever.

app.use(express.static('build/client', { maxAge: '1h' }));

// Initialize workflow orchestrator
await initializeWorkflows();

// Register and start workers inline (same process as the HTTP server)
try {
  const orchestrator = getOrchestrator();
  const boss = orchestrator.getBoss();
  await registerScheduledTasks(boss);
  await registerDomainVerifyWorker(boss);
  await registerEmailSendWorker(boss);
  await registerSesEventProcessWorker(boss);
  await registerWebhookDeliverWorker(boss);
  await registerInboundWebhookDeliverWorker(boss);
  await registerInboundProcessWorker(boss);
  await registerDnsHealthCheckAdhocWorker(boss);
  await startWorkflowWorker();
  logger.info('Workers registered and running');
} catch (err) {
  logger.fatal('Failed to start workers', { error: err instanceof Error ? err : new Error(String(err)) });
  process.exit(1);
}

// handle SSR requests
app.all('*', remixHandler);

const port = Number(process.env.PORT || 3601);
// HOST is optional. Unset, the server listens on every interface, as before.
// A local test run sets HOST=127.0.0.1 to keep the instance off the network.
const host = process.env.HOST;
const onListening = (): void => {
  logServerStart(port, { url: `http://${host ?? 'localhost'}:${port}` });
};
const server = host ? app.listen(port, host, onListening) : app.listen(port, onListening);

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, ignoring duplicate signal', { signal });
    return;
  }
  isShuttingDown = true;
  logShutdown(signal);

  // Timeout chain: SIGTERM → app cleanup (0-8s) → force exit (8s) → Docker SIGKILL (10s default)
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 8_000);
  forceExitTimer.unref();

  try {
    // Phase 1: Drain HTTP connections
    logger.info('Shutdown: draining HTTP connections');
    await new Promise<void>((resolve) => {
      server.close(() => {
        logServerClosed();
        resolve();
      });
      // Release Nginx keep-alive sockets immediately
      server.closeIdleConnections();
      // Force-close any remaining connections after grace period
      setTimeout(() => {
        server.closeAllConnections();
      }, 5000);
    });

    // Phase 2: Stop workflow worker (pg-boss)
    logger.info('Shutdown: stopping workflow worker');
    await stopWorkflowWorker();
    logger.info('Shutdown: workflow worker stopped');

    // Phase 3: Close DB pool
    logger.info('Shutdown: closing database pool');
    await closePool();
    logger.info('Shutdown: database pool closed');

    clearTimeout(forceExitTimer);
    logger.info('Shutdown: complete');
    process.exit(0);
  } catch (err) {
    logger.error('Shutdown: error during graceful shutdown', { error: err instanceof Error ? err : String(err) });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
