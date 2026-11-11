import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { AppAlreadyExistsError, createUniqueApp } from '../src/lib/apps.js';
import { PigeonClient, PigeonHttpError } from '../src/lib/pigeon-client.js';
import type { PigeonApp } from '../src/lib/types.js';
import { applyManifestCommand } from '../src/commands/manifest.js';
import { EXIT_ERROR } from '../src/lib/manifest-plan.js';
import {
  FULL_MANIFEST,
  ORIGIN,
  makeEmptyInstance,
  makeFakeClient,
  makeManifestDeps,
  makeManifestIo,
} from './manifest-test-helpers.js';

const TIME = '2026-11-10T10:00:00.000Z';
const WINNER: PigeonApp = { id: 'app_winner', name: 'my-app', createdAt: TIME };

function nameTaken(): PigeonHttpError {
  return new PigeonHttpError({
    status: 409,
    code: 'app_name_taken',
    message: 'Pigeon API error 409 on POST /v1/admin/apps: {"error":"app_name_taken"}',
  });
}

/** A client whose list answers come from `listAnswers` in turn (the last one repeats). */
function scriptedClient(opts: { listAnswers: PigeonApp[][]; createApp: () => Promise<{ app: PigeonApp; stateVersion: number | null }> }) {
  const calls: string[] = [];
  let listIndex = 0;
  return {
    calls,
    client: {
      listApps: async () => {
        calls.push('listApps');
        const apps = opts.listAnswers[Math.min(listIndex, opts.listAnswers.length - 1)] ?? [];
        listIndex += 1;
        return { status: 200, apps };
      },
      createApp: async () => {
        calls.push('createApp');
        return opts.createApp();
      },
    },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

afterEach(() => mock.restoreAll());

describe('createUniqueApp', () => {
  it('refuses a name the list already has, before any create', async () => {
    const { client, calls } = scriptedClient({ listAnswers: [[WINNER]], createApp: async () => ({ app: WINNER, stateVersion: 0 }) });
    const error = await caught(createUniqueApp({ client, adminSecret: 'admin', name: 'my-app', force: false }));
    assert.ok(error instanceof AppAlreadyExistsError);
    assert.equal(error.message, 'An app named "my-app" already exists (id: app_winner). App names are unique.');
    assert.deepEqual(calls, ['listApps']);
  });

  it('turns the server 409 of a lost race into the same error, with the winner id', async () => {
    const { client, calls } = scriptedClient({ listAnswers: [[], [WINNER]], createApp: async () => Promise.reject(nameTaken()) });
    const error = await caught(createUniqueApp({ client, adminSecret: 'admin', name: 'my-app', force: false }));
    assert.ok(error instanceof AppAlreadyExistsError);
    assert.equal(error.message, 'An app named "my-app" already exists (id: app_winner). App names are unique.');
    assert.deepEqual(calls, ['listApps', 'createApp', 'listApps']);
  });

  it('cannot create a duplicate with force: the 409 ends the same way', async () => {
    const { client, calls } = scriptedClient({ listAnswers: [[WINNER]], createApp: async () => Promise.reject(nameTaken()) });
    const error = await caught(createUniqueApp({ client, adminSecret: 'admin', name: 'my-app', force: true }));
    assert.ok(error instanceof AppAlreadyExistsError);
    assert.deepEqual(calls, ['createApp', 'listApps']);
  });

  it('keeps the error when the id lookup fails too', async () => {
    let listCalls = 0;
    const client = {
      listApps: async () => {
        listCalls += 1;
        if (listCalls > 1) throw new Error('network down');
        return { status: 200, apps: [] };
      },
      createApp: async () => Promise.reject(nameTaken()),
    };
    const error = await caught(createUniqueApp({ client, adminSecret: 'admin', name: 'my-app', force: false }));
    assert.ok(error instanceof AppAlreadyExistsError);
    assert.equal(error.message, 'An app named "my-app" already exists. App names are unique.');
  });

  it('passes any other create error through unchanged', async () => {
    const failure = new PigeonHttpError({ status: 500, code: 'internal_error', message: 'boom' });
    const { client } = scriptedClient({ listAnswers: [[]], createApp: async () => Promise.reject(failure) });
    assert.equal(await caught(createUniqueApp({ client, adminSecret: 'admin', name: 'my-app', force: false })), failure);
  });

  it('returns the created app and its state version', async () => {
    const { client } = scriptedClient({ listAnswers: [[]], createApp: async () => ({ app: WINNER, stateVersion: 0 }) });
    assert.deepEqual(await createUniqueApp({ client, adminSecret: 'admin', name: 'my-app', force: false }), {
      app: WINNER,
      stateVersion: 0,
    });
  });
});

describe('PigeonClient.createApp against the 409 body', () => {
  it('reads the app_name_taken code from { error: "app_name_taken" }', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'app_name_taken' }), { status: 409 }));
    const error = await caught(new PigeonClient({ baseUrl: 'http://pigeon.test' }).createApp({ adminSecret: 'admin', name: 'my-app' }));
    assert.ok(error instanceof PigeonHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'app_name_taken');
  });
});

describe('manifest apply when the app appears between plan and create', () => {
  async function applyWith(client: ReturnType<typeof makeFakeClient>['client']): Promise<{ code: number; stderr: string }> {
    const capture = makeManifestIo();
    const code = await applyManifestCommand({
      source: { path: 'pigeon.toml', text: FULL_MANIFEST },
      tenantKey: null,
      origin: ORIGIN,
      isYes: true,
      vaultOpts: { vault: false, vaultEnv: 'production' },
      isJson: false,
      deps: makeManifestDeps({ client, io: capture.io }),
    });
    return { code, stderr: capture.stderr.join('') };
  }

  it('ends a server 409 exactly like the client-side duplicate check', async () => {
    // Client-side check: the plan saw no app, the check before the create sees one.
    const seenByCheck = makeFakeClient({ instance: makeEmptyInstance() });
    let checkLists = 0;
    const realList = seenByCheck.client.listApps;
    seenByCheck.client.listApps = async (args) => {
      checkLists += 1;
      return checkLists === 1 ? realList(args) : { status: 200, apps: [WINNER] };
    };
    const byCheck = await applyWith(seenByCheck.client);

    // Server 409: the check sees no app either, the create loses the race.
    const lostRace = makeFakeClient({ instance: makeEmptyInstance() });
    let raceLists = 0;
    const raceList = lostRace.client.listApps;
    lostRace.client.listApps = async (args) => {
      raceLists += 1;
      return raceLists <= 2 ? raceList(args) : { status: 200, apps: [WINNER] };
    };
    lostRace.client.createApp = async () => Promise.reject(nameTaken());
    const byServer = await applyWith(lostRace.client);

    assert.equal(byCheck.code, EXIT_ERROR);
    assert.equal(byServer.code, byCheck.code);
    for (const result of [byCheck, byServer]) {
      assert.match(result.stderr, /An app named "my-app" already exists \(id: app_winner\)\. App names are unique\./);
    }
  });
});
