import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunBay } from '../src/lib/bay-vault.js';
import type { PigeonWebhook, PigeonWebhookWithSecret } from '../src/lib/types.js';
import type { WebhookDeps, WebhookIo } from '../src/commands/webhooks.js';

/** The state version the fake app is at. */
export const STATE_VERSION = 4;

export const SECRET = 'whsec_TESTSECRET0123456789abcdefghijklmnopqrstuvwxyz0123456789AB';

export function makeWebhook(overrides: Partial<PigeonWebhook> = {}): PigeonWebhook {
  return {
    id: 'wh_1',
    appId: 'app_1',
    url: 'https://example.com/hook',
    eventTypes: ['email.sent'],
    enabled: true,
    lastSuccessAt: null,
    lastFailureAt: null,
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

export function makeFleetDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pigeon-fleet-'));
}

export interface CapturedIo {
  io: WebhookIo;
  stdout: string[];
  stderr: string[];
  allOutput: () => string;
}

export function makeIo(opts: { failStdoutWrite?: boolean } = {}): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: WebhookIo = {
    log: (text) => {
      stdout.push(`${text}\n`);
    },
    writeStdout: async (text) => {
      if (opts.failStdoutWrite) throw new Error(`EPIPE: broken pipe while writing ${text}`);
      stdout.push(text);
    },
    writeStderr: (text) => {
      stderr.push(`${text}\n`);
    },
  };
  return { io, stdout, stderr, allOutput: () => [...stdout, ...stderr].join('') };
}

export interface FakeVault {
  runBay: RunBay;
  calls: Array<{ args: string[]; stdin?: string }>;
  secrets: Map<string, string>;
}

/** An in-memory `bay vault`. With `failSet`, `vault set` fails and echoes its stdin on stderr. */
export function makeFakeVault(opts: { failSet?: boolean; existing?: Record<string, string> } = {}): FakeVault {
  const secrets = new Map(Object.entries(opts.existing ?? {}));
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const runBay: RunBay = async (call) => {
    calls.push(call);
    const verb = call.args[3];
    if (verb === 'view') {
      const lines = [...secrets].map(([name, value]) => `  ${name}: ${value}`);
      return { exitCode: 0, stdout: `secrets:\n${lines.join('\n')}\n`, stderr: '' };
    }
    if (opts.failSet) {
      return { exitCode: 1, stdout: '', stderr: `vault locked, input was ${call.stdin ?? ''}` };
    }
    secrets.set(call.args[5] ?? '', call.stdin ?? '');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { runBay, calls, secrets };
}

export function makeDeps(opts: {
  io: WebhookIo;
  runBay?: RunBay;
  client?: Partial<WebhookDeps['client']>;
}): WebhookDeps & { apiCalls: string[] } {
  const apiCalls: string[] = [];
  const result: PigeonWebhookWithSecret = { webhook: makeWebhook(), signingSecret: SECRET };
  const client: WebhookDeps['client'] = {
    listWebhooks: async () => {
      apiCalls.push('list');
      return { webhooks: [makeWebhook()], stateVersion: STATE_VERSION };
    },
    createWebhook: async () => {
      apiCalls.push('create');
      return { ...result, stateVersion: STATE_VERSION + 1 };
    },
    rotateWebhookSecret: async ({ expectedVersion }) => {
      apiCalls.push(`rotate:${expectedVersion ?? 'none'}`);
      return { ...result, stateVersion: STATE_VERSION + 1 };
    },
    updateWebhookEvents: async ({ eventTypes, expectedVersion }) => {
      apiCalls.push(`update:${eventTypes.join(',')}:${expectedVersion ?? 'none'}`);
      return { webhook: makeWebhook({ eventTypes }), stateVersion: STATE_VERSION + 1 };
    },
    getAppStateVersion: async () => {
      apiCalls.push('version');
      return STATE_VERSION;
    },
    ...opts.client,
  };
  return {
    client,
    adminSecret: 'admin-secret',
    runBay: opts.runBay ?? makeFakeVault().runBay,
    io: opts.io,
    apiCalls,
  };
}
