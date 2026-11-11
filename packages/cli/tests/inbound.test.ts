import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addInboundDomainCommand,
  listInboundDomainsCommand,
  listInboundEmailsCommand,
  parseInboundDomain,
  parseListLimit,
  replayInboundEmailCommand,
} from '../src/commands/inbound.js';
import type { InboundDeps } from '../src/commands/inbound.js';
import type { PigeonInboundDomain, PigeonInboundEmailSummary } from '../src/lib/types.js';

const DOMAIN: PigeonInboundDomain = {
  id: 'ind_1',
  appId: 'app_1',
  name: 'reply.example.test',
  region: 'eu-central-1',
  enabled: true,
  createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
};

const EMAIL: PigeonInboundEmailSummary = {
  id: 'ie_1',
  inboundDomainId: 'ind_1',
  receivedAt: '2026-11-09T10:00:00.000Z',
  recipientCount: 2,
  createdAt: '2026-11-09T10:00:01.000Z',
};

function makeInboundDeps(opts: { domains?: PigeonInboundDomain[]; emails?: PigeonInboundEmailSummary[] } = {}) {
  const apiCalls: string[] = [];
  const output: string[] = [];
  const deps: InboundDeps = {
    adminSecret: 'admin-secret',
    log: (text) => {
      output.push(`${text}\n`);
    },
    client: {
      listInboundDomains: async ({ appId }) => {
        apiCalls.push(`domains:${appId}`);
        return { inboundDomains: opts.domains ?? [DOMAIN], stateVersion: 1 };
      },
      addInboundDomain: async ({ appId, name }) => {
        apiCalls.push(`add:${appId}:${name}`);
        return { inboundDomain: { ...DOMAIN, name }, stateVersion: 2 };
      },
      listInboundEmails: async ({ appId, limit }) => {
        apiCalls.push(`emails:${appId}:${limit ?? 'default'}`);
        return { inboundEmails: opts.emails ?? [EMAIL] };
      },
      replayInboundEmail: async ({ appId, inboundEmailId }) => {
        apiCalls.push(`replay:${appId}:${inboundEmailId}`);
        return { inboundEmailId, jobId: 'job_1' };
      },
    },
  };
  return { deps, apiCalls, stdout: () => output.join('') };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the promise to reject.');
}

describe('parseInboundDomain', () => {
  it('lowercases, trims and drops a trailing dot', () => {
    assert.equal(parseInboundDomain('  Reply.Example.TEST. '), 'reply.example.test');
  });

  it('refuses an address, a URL and a bare label', () => {
    assert.throws(() => parseInboundDomain('someone@reply.example.test'), /Not a domain name/);
    assert.throws(() => parseInboundDomain('https://reply.example.test'), /Not a domain name/);
    assert.throws(() => parseInboundDomain('localhost'), /Not a domain name/);
  });
});

describe('parseListLimit', () => {
  it('passes undefined through and accepts 1 to 200', () => {
    assert.equal(parseListLimit(undefined), undefined);
    assert.equal(parseListLimit('1'), 1);
    assert.equal(parseListLimit('200'), 200);
  });

  it('refuses 0, 201 and a fraction', () => {
    assert.throws(() => parseListLimit('0'), /1 to 200/);
    assert.throws(() => parseListLimit('201'), /1 to 200/);
    assert.throws(() => parseListLimit('2.5'), /1 to 200/);
  });
});

describe('inbound-domains', () => {
  it('list prints a table', async () => {
    const { deps, apiCalls, stdout } = makeInboundDeps();
    await listInboundDomainsCommand({ appId: 'app_1', isJson: false, deps });
    assert.deepEqual(apiCalls, ['domains:app_1']);
    assert.match(stdout(), /ID\s+Domain\s+Region\s+Enabled\s+Created/);
    assert.match(stdout(), /ind_1\s+reply\.example\.test\s+eu-central-1\s+yes/);
  });

  it('list says so when there are none', async () => {
    const { deps, stdout } = makeInboundDeps({ domains: [] });
    await listInboundDomainsCommand({ appId: 'app_1', isJson: false, deps });
    assert.match(stdout(), /No inbound domains found/);
  });

  it('add sends the normalised name', async () => {
    const { deps, apiCalls, stdout } = makeInboundDeps();
    await addInboundDomainCommand({ appId: 'app_1', domain: 'Reply.Example.Test', isJson: false, deps });
    assert.deepEqual(apiCalls, ['add:app_1:reply.example.test']);
    assert.match(stdout(), /Inbound domain reply\.example\.test added \(ind_1\)/);
  });

  it('add refuses a bad domain before the API call', async () => {
    const { deps, apiCalls } = makeInboundDeps();
    const message = await rejectionMessage(
      addInboundDomainCommand({ appId: 'app_1', domain: 'not a domain', isJson: false, deps }),
    );
    assert.match(message, /Not a domain name/);
    assert.deepEqual(apiCalls, []);
  });
});

describe('inbound', () => {
  it('list prints ids, times and recipient counts', async () => {
    const { deps, apiCalls, stdout } = makeInboundDeps();
    await listInboundEmailsCommand({ appId: 'app_1', limit: '10', isJson: false, deps });
    assert.deepEqual(apiCalls, ['emails:app_1:10']);
    assert.match(stdout(), /ID\s+Received\s+Recipients/);
    assert.match(stdout(), /ie_1\s+2026-11-09T10:00:00\.000Z\s+2/);
  });

  it('list --json holds only id, receivedAt and recipientCount', async () => {
    const { deps, stdout } = makeInboundDeps();
    await listInboundEmailsCommand({ appId: 'app_1', limit: undefined, isJson: true, deps });
    const json = JSON.parse(stdout()) as Array<Record<string, unknown>>;
    assert.deepEqual(json, [{ id: 'ie_1', receivedAt: EMAIL.receivedAt, recipientCount: 2 }]);
  });

  it('list refuses a bad --limit before the API call', async () => {
    const { deps, apiCalls } = makeInboundDeps();
    const message = await rejectionMessage(
      listInboundEmailsCommand({ appId: 'app_1', limit: '500', isJson: false, deps }),
    );
    assert.match(message, /--limit/);
    assert.deepEqual(apiCalls, []);
  });

  it('replay queues the mail and prints the job id', async () => {
    const { deps, apiCalls, stdout } = makeInboundDeps();
    await replayInboundEmailCommand({ appId: 'app_1', inboundEmailId: 'ie_1', isJson: false, deps });
    assert.deepEqual(apiCalls, ['replay:app_1:ie_1']);
    assert.match(stdout(), /Inbound email ie_1 queued again \(job job_1\)/);
  });
});
