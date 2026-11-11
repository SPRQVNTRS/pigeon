import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { Command } from 'commander';
import { SUPPORTED_API, checkApiVersion, formatRange, isRefusal } from '../src/lib/api-version.js';
import { PigeonClient, PigeonUnreachableError } from '../src/lib/pigeon-client.js';
import {
  ApiVersionRefusedError,
  OFFLINE_COMMAND_PATHS,
  getCommandPath,
  installVersionGuard,
} from '../src/lib/version-guard.js';

const RANGE = { min: 2, max: 3 };
const execFileAsync = promisify(execFile);

afterEach(() => mock.restoreAll());

describe('checkApiVersion', () => {
  it('accepts the bounds and everything between', () => {
    for (const serverVersion of [2, 3]) {
      assert.deepEqual(checkApiVersion({ serverVersion, supported: RANGE }), { outcome: 'ok' });
    }
  });

  it('cli-stale when the server is newer: both numbers and the git pull step', () => {
    const check = checkApiVersion({ serverVersion: 4, supported: RANGE });
    assert.equal(check.outcome, 'cli-stale');
    assert.ok(isRefusal(check));
    assert.match(check.message, /older than the pigeon server/);
    assert.match(check.message, /version 4/);
    assert.match(check.message, /2 to 3/);
    assert.match(check.message, /git pull/);
  });

  it('server-old when the server is older: deploy or older checkout', () => {
    const check = checkApiVersion({ serverVersion: 1, supported: RANGE });
    assert.equal(check.outcome, 'server-old');
    assert.ok(isRefusal(check));
    assert.match(check.message, /server is older than this CLI/);
    assert.match(check.message, /Deploy pigeon/);
    assert.match(check.message, /older workspace checkout/);
  });

  it('unknown when the server reports no version: a refusal with its own message', () => {
    const check = checkApiVersion({ serverVersion: null, supported: RANGE });
    assert.equal(check.outcome, 'unknown');
    assert.ok(isRefusal(check));
    assert.match(check.message, /reports no API version/);
    assert.match(check.message, /older than this CLI/);
    assert.match(check.message, /Deploy the current pigeon service/);
    assert.match(check.message, /older checkout of the workspace/);
    assert.equal(check.message.includes('skipped'), false);
  });

  it('only ok is not a refusal', () => {
    assert.equal(isRefusal({ outcome: 'ok' }), false);
  });

  it('refuses malformed values instead of treating them as unknown', () => {
    for (const serverVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const check = checkApiVersion({ serverVersion, supported: { min: 1, max: 100 } });
      assert.equal(check.outcome, 'malformed', String(serverVersion));
      assert.ok(isRefusal(check));
    }
  });

  it('formats a single-version range as one number', () => {
    assert.equal(formatRange(SUPPORTED_API), '1');
    assert.equal(formatRange(RANGE), '2 to 3');
  });
});

describe('PigeonClient.fetchApiVersion', () => {
  const client = new PigeonClient({ baseUrl: 'http://pigeon.test/' });

  function stubFetch(respond: () => Response | Promise<Response>): Array<{ url: string; init?: RequestInit }> {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond();
    });
    return calls;
  }

  it('GETs /healthz without credentials and reads apiVersion', async () => {
    const calls = stubFetch(() => Response.json({ status: 'ok', check: 'database', apiVersion: 3 }));
    assert.equal(await client.fetchApiVersion(), 3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://pigeon.test/healthz');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.equal(JSON.stringify(calls[0]?.init?.headers).toLowerCase().includes('authorization'), false);
  });

  it('returns null when the field is absent', async () => {
    stubFetch(() => Response.json({ status: 'ok', check: 'database' }));
    assert.equal(await client.fetchApiVersion(), null);
  });

  it('still yields the version from a 503 that carries a JSON body', async () => {
    stubFetch(() => Response.json({ status: 'error', message: 'down', apiVersion: 2 }, { status: 503 }));
    assert.equal(await client.fetchApiVersion(), 2);
  });

  it('returns NaN for a field that is not a number, so the check refuses it', async () => {
    stubFetch(() => Response.json({ apiVersion: '2' }));
    const serverVersion = await client.fetchApiVersion();
    assert.ok(Number.isNaN(serverVersion));
    assert.equal(checkApiVersion({ serverVersion, supported: SUPPORTED_API }).outcome, 'malformed');
  });

  it('rejects with the URL when the request fails', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    });
    await assert.rejects(
      client.fetchApiVersion(),
      (error: unknown) =>
        error instanceof PigeonUnreachableError &&
        error.message.startsWith('Cannot reach pigeon at http://pigeon.test:') &&
        error.message.includes('ECONNREFUSED'),
    );
  });

  it('rejects when the body is not JSON, without echoing it', async () => {
    stubFetch(() => new Response('<html>Bad gateway SECRET-BODY</html>', { status: 502 }));
    await assert.rejects(
      client.fetchApiVersion(),
      (error: unknown) =>
        error instanceof PigeonUnreachableError &&
        error.message.startsWith('Cannot reach pigeon at http://pigeon.test:') &&
        !error.message.includes('SECRET-BODY'),
    );
  });
});

describe('version guard', () => {
  interface Harness {
    program: Command;
    actionRuns: string[];
    stdout: string[];
    fetchCalls: number;
  }

  /** A program shaped like the real one: online `status`, online and offline `manifest` subcommands. */
  function buildHarness(opts: { fetchApiVersion: () => Promise<number | null> }): Harness {
    const harness: Harness = {
      program: new Command(),
      actionRuns: [],
      stdout: [],
      fetchCalls: 0,
    };
    const { program } = harness;
    program.name('pigeon').option('--json', 'Output raw JSON', false).exitOverride();

    const run = (name: string) => () => {
      harness.actionRuns.push(name);
      console.log(JSON.stringify({ ran: name }));
    };
    program.command('status').action(run('status'));
    const manifest = program.command('manifest');
    manifest.command('validate').action(run('manifest validate'));
    manifest.command('plan').action(run('manifest plan'));

    installVersionGuard(program, {
      fetchApiVersion: () => {
        harness.fetchCalls += 1;
        return opts.fetchApiVersion();
      },
      supported: { min: 1, max: 1 },
    });

    mock.method(console, 'log', (line: string) => harness.stdout.push(line));
    return harness;
  }

  function parse(harness: Harness, args: string[]): Promise<Command> {
    return harness.program.parseAsync(['node', 'pigeon', ...args]);
  }

  it('lists only manifest validate as offline', () => {
    assert.deepEqual([...OFFLINE_COMMAND_PATHS], ['manifest validate']);
  });

  it('derives the full path of nested commands', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => 1 });
    const paths: string[] = [];
    harness.program.hook('preAction', (_hooked, actionCommand) => {
      paths.push(getCommandPath(actionCommand));
    });
    await parse(harness, ['manifest', 'plan']);
    assert.deepEqual(paths, ['manifest plan']);
  });

  it('runs the command after an ok check, with one version request', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => 1 });
    await parse(harness, ['status']);
    assert.deepEqual(harness.actionRuns, ['status']);
    assert.equal(harness.fetchCalls, 1);
  });

  it('refuses a stale CLI and never runs the action', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => 2 });
    await assert.rejects(
      parse(harness, ['status']),
      (error: unknown) => error instanceof ApiVersionRefusedError && /older than the pigeon server/.test(error.message),
    );
    assert.deepEqual(harness.actionRuns, []);
    assert.equal(harness.fetchCalls, 1);
    assert.deepEqual(harness.stdout, []);
  });

  it('refuses an old server and a malformed version the same way', async () => {
    for (const version of [0, Number.NaN]) {
      const harness = buildHarness({ fetchApiVersion: async () => version });
      await assert.rejects(parse(harness, ['manifest', 'plan']), ApiVersionRefusedError);
      assert.deepEqual(harness.actionRuns, []);
      mock.restoreAll();
    }
  });

  it('refuses when the server cannot be reached and never runs the action', async () => {
    const harness = buildHarness({
      fetchApiVersion: async () => {
        throw new PigeonUnreachableError({ baseUrl: 'http://pigeon.test', reason: 'fetch failed' });
      },
    });
    await assert.rejects(parse(harness, ['status']), PigeonUnreachableError);
    assert.deepEqual(harness.actionRuns, []);
  });

  it('makes no request at all for the offline command', async () => {
    const harness = buildHarness({
      fetchApiVersion: async () => {
        throw new Error('must not be called');
      },
    });
    await parse(harness, ['manifest', 'validate']);
    assert.deepEqual(harness.actionRuns, ['manifest validate']);
    assert.equal(harness.fetchCalls, 0);
  });

  it('checks a manifest command that is not on the offline list', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => 1 });
    await parse(harness, ['manifest', 'plan']);
    assert.equal(harness.fetchCalls, 1);
  });

  it('refuses an unknown version, never runs the action and keeps stdout empty', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => null });
    await assert.rejects(
      parse(harness, ['status']),
      (error: unknown) => error instanceof ApiVersionRefusedError && /reports no API version/.test(error.message),
    );
    assert.deepEqual(harness.actionRuns, []);
    assert.equal(harness.fetchCalls, 1);
    assert.deepEqual(harness.stdout, []);
  });

  it('keeps stdout empty with --json when it refuses an unknown version', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => null });
    await assert.rejects(parse(harness, ['--json', 'status']), ApiVersionRefusedError);
    assert.deepEqual(harness.actionRuns, []);
    assert.deepEqual(harness.stdout, []);
  });

  it('refuses an unknown version for a nested manifest command too', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => null });
    await assert.rejects(parse(harness, ['manifest', 'plan']), ApiVersionRefusedError);
    assert.deepEqual(harness.actionRuns, []);
  });

  it('still lets the offline command run when the server reports no version', async () => {
    const harness = buildHarness({ fetchApiVersion: async () => null });
    await parse(harness, ['manifest', 'validate']);
    assert.deepEqual(harness.actionRuns, ['manifest validate']);
    assert.equal(harness.fetchCalls, 0);
  });
});

describe('pigeon CLI process against a server that reports no API version', () => {
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  let server: Server;
  let baseUrl: string;
  let adminRequests: number;

  before(async () => {
    adminRequests = 0;
    server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ status: 'ok', check: 'database' }));
        return;
      }
      adminRequests += 1;
      response.end(JSON.stringify({ apps: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', cliPath, ...args],
        {
          env: {
            ...process.env,
            PIGEON_ADMIN_URL: baseUrl,
            PIGEON_ADMIN_SECRET: 'test-secret',
            NO_PROXY: '127.0.0.1',
            no_proxy: '127.0.0.1',
          },
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error: unknown) {
      const failure = error as { code?: number | null; stdout?: string; stderr?: string };
      return { code: failure.code ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  it('status exits 1 with the reason on stderr, nothing on stdout, and never reaches the admin API', async () => {
    const result = await runCli(['--json', 'status']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error: The pigeon server reports no API version, so it is older than this CLI\./);
    assert.equal(adminRequests, 0);
  });
});
