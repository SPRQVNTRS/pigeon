import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createWebhookCommand,
  listWebhooksCommand,
  rotateWebhookCommand,
  updateWebhookCommand,
} from '../src/commands/webhooks.js';
import { WebhookExistsError } from '../src/lib/pigeon-client.js';
import { SECRET, makeDeps, makeFakeVault, makeFleetDir, makeIo, makeWebhook } from './webhook-test-helpers.js';

const BASE = { appId: 'app_1', url: 'https://example.com/hook', events: 'email.sent,email.bounced' };

function stdoutSink() {
  return { secretStdout: true, vaultEnv: 'production' };
}

function vaultSink(fleet: string) {
  return { vault: 'APP_WEBHOOK_SECRET', vaultEnv: 'production', fleet };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the promise to reject.');
}

describe('sink validation (before any API call)', () => {
  it('refuses when no sink is given', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const message = await rejectionMessage(
      createWebhookCommand({ ...BASE, sinkOpts: { vaultEnv: 'production' }, isJson: false, isStdoutTty: false, deps }),
    );
    assert.match(message, /exactly one secret sink/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('refuses when two sinks are given', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const message = await rejectionMessage(
      createWebhookCommand({
        ...BASE,
        sinkOpts: { secretStdout: true, vault: 'X_KEY', vaultEnv: 'production' },
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
    );
    assert.match(message, /only one of --secret-stdout and --vault/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('refuses --secret-stdout on a terminal', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const message = await rejectionMessage(
      createWebhookCommand({ ...BASE, sinkOpts: stdoutSink(), isJson: false, isStdoutTty: true, deps }),
    );
    assert.match(message, /terminal/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('refuses --secret-stdout with --json', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const message = await rejectionMessage(
      rotateWebhookCommand({
        appId: 'app_1',
        webhookId: 'wh_1',
        sinkOpts: stdoutSink(),
        isJson: true,
        isStdoutTty: false,
        deps,
      }),
    );
    assert.match(message, /--json/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('refuses an invalid vault name and a missing fleet', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const badName = await rejectionMessage(
      createWebhookCommand({
        ...BASE,
        sinkOpts: { vault: 'lower', vaultEnv: 'production', fleet: makeFleetDir() },
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
    );
    assert.match(badName, /Invalid vault key name/);

    const badFleet = await rejectionMessage(
      createWebhookCommand({
        ...BASE,
        sinkOpts: { vault: 'GOOD_NAME', vaultEnv: 'production', fleet: '/nonexistent/fleet' },
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
    );
    assert.match(badFleet, /fleet directory not found/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('refuses unknown event types before the API call', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const message = await rejectionMessage(
      createWebhookCommand({
        ...BASE,
        events: 'email.sent,email.exploded',
        sinkOpts: stdoutSink(),
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
    );
    assert.match(message, /Unknown event type: email\.exploded/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('refuses a vault name that is already taken on create, before the API call', async () => {
    const { io } = makeIo();
    const vault = makeFakeVault({ existing: { APP_WEBHOOK_SECRET: 'old' } });
    const deps = makeDeps({ io, runBay: vault.runBay });
    const message = await rejectionMessage(
      createWebhookCommand({
        ...BASE,
        sinkOpts: vaultSink(makeFleetDir()),
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
    );
    assert.match(message, /already holds APP_WEBHOOK_SECRET/);
    assert.deepEqual(deps.apiCalls, []);
  });
});

describe('--secret-stdout', () => {
  it('writes only the secret and a newline to stdout, and the rest to stderr', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io });
    await createWebhookCommand({ ...BASE, sinkOpts: stdoutSink(), isJson: false, isStdoutTty: false, deps });

    assert.equal(captured.stdout.join(''), `${SECRET}\n`);
    const stderr = captured.stderr.join('');
    assert.match(stderr, /webhook: wh_1/);
    assert.match(stderr, /url: https:\/\/example\.com\/hook/);
    assert.match(stderr, /secret: emitted to stdout \(64 chars\)/);
    assert.ok(!stderr.includes(SECRET));
  });

  it('parses and dedupes events before the API call', async () => {
    const captured = makeIo();
    let sent: string[] = [];
    const deps = makeDeps({
      io: captured.io,
      client: {
        createWebhook: async (opts) => {
          sent = opts.eventTypes;
          return { webhook: makeWebhook(), signingSecret: SECRET, stateVersion: 1 };
        },
      },
    });
    await createWebhookCommand({
      ...BASE,
      events: ' email.sent, email.sent ,,email.bounced',
      sinkOpts: stdoutSink(),
      isJson: false,
      isStdoutTty: false,
      deps,
    });
    assert.deepEqual(sent, ['email.sent', 'email.bounced']);
  });

  it('on a stdout write failure, throws id and rotate hint, and never shows the secret', async () => {
    const captured = makeIo({ failStdoutWrite: true });
    const deps = makeDeps({ io: captured.io });
    const message = await rejectionMessage(
      createWebhookCommand({ ...BASE, sinkOpts: stdoutSink(), isJson: false, isStdoutTty: false, deps }),
    );
    assert.match(message, /wh_1/);
    assert.match(message, /pigeon webhooks rotate app_1 wh_1 --secret-stdout/);
    assert.ok(!message.includes(SECRET));
    assert.ok(!captured.allOutput().includes(SECRET));
  });
});

describe('--vault', () => {
  it('stores the secret and prints no secret anywhere', async () => {
    const captured = makeIo();
    const vault = makeFakeVault();
    const deps = makeDeps({ io: captured.io, runBay: vault.runBay });
    await createWebhookCommand({
      ...BASE,
      sinkOpts: vaultSink(makeFleetDir()),
      isJson: false,
      isStdoutTty: false,
      deps,
    });

    assert.equal(vault.secrets.get('APP_WEBHOOK_SECRET'), SECRET);
    assert.match(captured.stdout.join(''), /Secret stored as APP_WEBHOOK_SECRET \(production\); the secret is not shown/);
    assert.match(captured.stderr.join(''), /secret: stored in vault/);
    assert.ok(!captured.allOutput().includes(SECRET));
  });

  it('--json emits the webhook plus vault info, with no secret', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io, runBay: makeFakeVault().runBay });
    await createWebhookCommand({
      ...BASE,
      sinkOpts: vaultSink(makeFleetDir()),
      isJson: true,
      isStdoutTty: false,
      deps,
    });

    const json = JSON.parse(captured.stdout.join('')) as Record<string, unknown>;
    assert.deepEqual(json.vault, { name: 'APP_WEBHOOK_SECRET', env: 'production', stored: true });
    assert.equal((json.webhook as { id: string }).id, 'wh_1');
    assert.ok(!captured.allOutput().includes(SECRET));
    assert.ok(!('signingSecret' in json));
  });

  it('on a vault failure after create, throws id and rotate hint, and the secret appears nowhere', async () => {
    const captured = makeIo();
    const fleet = makeFleetDir();
    const vault = makeFakeVault({ failSet: true });
    const deps = makeDeps({ io: captured.io, runBay: vault.runBay });
    const message = await rejectionMessage(
      createWebhookCommand({
        ...BASE,
        sinkOpts: { vault: 'APP_WEBHOOK_SECRET', vaultEnv: 'staging', fleet },
        isJson: false,
        isStdoutTty: false,
        deps,
      }),
    );

    assert.deepEqual(deps.apiCalls, ['create']);
    assert.match(message, /Webhook wh_1 was created/);
    assert.match(
      message,
      new RegExp(`pigeon webhooks rotate app_1 wh_1 --vault APP_WEBHOOK_SECRET --vault-env staging --fleet ${fleet}`),
    );
    assert.ok(!message.includes(SECRET), 'bay stderr echoed the secret, so it must be redacted');
    assert.equal(captured.stdout.join(''), '');
    assert.ok(!captured.allOutput().includes(SECRET));
  });

  it('rotate may replace a secret that already lives under the name', async () => {
    const captured = makeIo();
    const vault = makeFakeVault({ existing: { APP_WEBHOOK_SECRET: 'old' } });
    const deps = makeDeps({ io: captured.io, runBay: vault.runBay });
    await rotateWebhookCommand({
      appId: 'app_1',
      webhookId: 'wh_1',
      sinkOpts: vaultSink(makeFleetDir()),
      isJson: false,
      isStdoutTty: false,
      deps,
    });
    assert.equal(vault.secrets.get('APP_WEBHOOK_SECRET'), SECRET);
    assert.match(captured.stdout.join(''), /Webhook wh_1 rotated/);
  });
});

describe('create 409', () => {
  it('surfaces the existing webhook id and a rotate hint', async () => {
    const captured = makeIo();
    const deps = makeDeps({
      io: captured.io,
      client: {
        createWebhook: async () => {
          throw new WebhookExistsError({ status: 409, message: 'exists', webhookId: 'wh_existing' });
        },
      },
    });
    const message = await rejectionMessage(
      createWebhookCommand({ ...BASE, sinkOpts: stdoutSink(), isJson: false, isStdoutTty: false, deps }),
    );
    assert.match(message, /Webhook wh_existing already exists/);
    assert.match(message, /pigeon webhooks rotate app_1 wh_existing --secret-stdout/);
    assert.match(message, /only if you mean to replace its secret/);
    assert.equal(captured.stdout.join(''), '');
  });
});

describe('list', () => {
  it('prints a table', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io });
    await listWebhooksCommand({ appId: 'app_1', isJson: false, deps });
    const out = captured.stdout.join('');
    assert.match(out, /ID\s+URL\s+Events\s+Enabled\s+Last success\s+Last failure/);
    assert.match(out, /wh_1\s+https:\/\/example\.com\/hook\s+email\.sent\s+yes\s+-\s+-/);
  });

  it('prints JSON with --json', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io });
    await listWebhooksCommand({ appId: 'app_1', isJson: true, deps });
    const json = JSON.parse(captured.stdout.join('')) as Array<{ id: string }>;
    assert.equal(json[0]?.id, 'wh_1');
  });
});

describe('update', () => {
  it('sends the parsed event types and prints the new list', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io });
    await updateWebhookCommand({
      appId: 'app_1',
      webhookId: 'wh_1',
      events: ' email.bounced, email.received ,email.bounced',
      isJson: false,
      deps,
    });
    // It reads the state version first and sends it as If-Match (STATE_VERSION in the fake).
    assert.deepEqual(deps.apiCalls, ['version', 'update:email.bounced,email.received:4']);
    assert.match(captured.stdout.join(''), /Webhook wh_1 now receives: email\.bounced, email\.received/);
    assert.equal(captured.stderr.join(''), '');
  });

  it('refuses unknown event types before the API call', async () => {
    const { io } = makeIo();
    const deps = makeDeps({ io });
    const message = await rejectionMessage(
      updateWebhookCommand({ appId: 'app_1', webhookId: 'wh_1', events: 'email.recieved', isJson: false, deps }),
    );
    assert.match(message, /Unknown event type: email\.recieved/);
    assert.deepEqual(deps.apiCalls, []);
  });

  it('prints the webhook as JSON with --json', async () => {
    const captured = makeIo();
    const deps = makeDeps({ io: captured.io });
    await updateWebhookCommand({ appId: 'app_1', webhookId: 'wh_1', events: '*', isJson: true, deps });
    const json = JSON.parse(captured.stdout.join('')) as { id: string; eventTypes: string[] };
    assert.deepEqual(json.eventTypes, ['*']);
  });
});
