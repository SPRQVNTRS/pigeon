import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FLEET_ENV_VAR, resolveFleetPath } from '../src/lib/bay-vault.js';
import { createWebhookCommand } from '../src/commands/webhooks.js';
import { makeDeps, makeIo } from './webhook-test-helpers.js';

function makeDir(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pigeon-fleet-test-')));
}

describe('resolveFleetPath', () => {
  it('prefers the --fleet flag over PIGEON_BAY_FLEET', () => {
    const flagDir = makeDir();
    const envDir = makeDir();
    assert.equal(resolveFleetPath(flagDir, { env: { [FLEET_ENV_VAR]: envDir } }), flagDir);
  });

  it('falls back to PIGEON_BAY_FLEET', () => {
    const envDir = makeDir();
    assert.equal(resolveFleetPath(undefined, { env: { [FLEET_ENV_VAR]: envDir } }), envDir);
  });

  it('has no default path: neither flag nor env var is an error that names both', () => {
    assert.throws(() => resolveFleetPath(undefined, { env: {} }), /--fleet <path> or set PIGEON_BAY_FLEET/);
    assert.throws(() => resolveFleetPath(undefined, { env: { [FLEET_ENV_VAR]: '' } }), /PIGEON_BAY_FLEET/);
  });

  it('takes a relative path from the invocation directory', () => {
    const root = makeDir();
    mkdirSync(path.join(root, 'fleet'));
    assert.equal(resolveFleetPath('fleet', { env: { INIT_CWD: root }, cwd: '/somewhere/else' }), path.join(root, 'fleet'));
  });

  it('refuses a directory that does not exist', () => {
    assert.throws(() => resolveFleetPath('/nonexistent/fleet', { env: {} }), /fleet directory not found/);
  });
});

describe('--vault without a fleet', () => {
  let before: string | undefined;

  beforeEach(() => {
    before = process.env[FLEET_ENV_VAR];
    delete process.env[FLEET_ENV_VAR];
  });

  afterEach(() => {
    if (before !== undefined) process.env[FLEET_ENV_VAR] = before;
  });

  it('fails before any API call', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    await assert.rejects(
      createWebhookCommand({
        appId: 'app_1',
        url: 'https://example.com/hook',
        events: 'email.sent',
        sinkOpts: { vault: 'APP_WEBHOOK_SECRET', vaultEnv: 'production' },
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
      /--vault needs a Bay fleet directory\. Pass --fleet <path> or set PIGEON_BAY_FLEET/,
    );
    assert.deepEqual(deps.apiCalls, []);
  });
});
