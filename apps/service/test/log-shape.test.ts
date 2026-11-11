/**
 * Contract test: the shape of a production log line.
 *
 * Operators grep and parse these lines, so the field names are a contract that
 * must survive upgrades of @sprqvntrs/logger. The line is produced by a child
 * process that runs the real application logger with NODE_ENV=production.
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const run = promisify(execFile);
const serviceRoot = resolve(import.meta.dirname, '..');
const probePath = resolve(import.meta.dirname, 'support/log-shape-probe.ts');

async function readProductionLine(extraEnv: Record<string, string>): Promise<Record<string, unknown>> {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', probePath], {
    cwd: serviceRoot,
    env: {
      PATH: process.env['PATH'],
      NODE_ENV: 'production',
      ...extraEnv,
    },
  });
  const lines = stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

describe('production log line', () => {
  it('is one JSON object with the field names operators rely on', async () => {
    const line = await readProductionLine({});

    expect(line).toMatchObject({
      level: 'info',
      service: 'pigeon',
      env: 'production',
      component: 'SnsWebhookRoute',
      messageId: 'message-1',
      msg: 'Enqueued SES event',
    });
    expect(typeof line['time']).toBe('string');
    expect(new Date(line['time'] as string).toISOString()).toBe(line['time']);
  });

  it('takes the service name from PIGEON_SERVICE_NAME', async () => {
    const line = await readProductionLine({ PIGEON_SERVICE_NAME: 'pigeon-under-test' });

    expect(line['service']).toBe('pigeon-under-test');
  });
});
