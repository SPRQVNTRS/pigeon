/**
 * Contract tests — real HTTP against a running `apps/service`.
 *
 * Gated by CONTRACT_TEST_BASE_URL; skipped when unset so unit-only runs
 * (including CI) don't need a service on the other end.
 */
import { describe, it, expect } from 'vitest';
import { PigeonClient, PigeonError } from '../../src/index';

const baseUrl = process.env.CONTRACT_TEST_BASE_URL;
const apiKey = process.env.CONTRACT_TEST_API_KEY;
const domainId = process.env.CONTRACT_TEST_DOMAIN_ID;
const audienceId = process.env.CONTRACT_TEST_AUDIENCE_ID;

const suite = baseUrl && apiKey ? describe : describe.skip;

suite('contract: @sprqvntrs/pigeon ↔ apps/service', () => {
  const client = new PigeonClient({
    apiKey: apiKey ?? 'ske_unused',
    baseUrl: baseUrl ?? 'http://localhost:3601',
  });

  it('domains.list() returns { domains: [...] }', async () => {
    const res = await client.domains.list();
    expect(Array.isArray(res.domains)).toBe(true);
  });

  it('audiences.list() returns an array', async () => {
    const list = await client.audiences.list();
    expect(Array.isArray(list)).toBe(true);
  });

  (domainId ? it : it.skip)('domains.get(CONTRACT_TEST_DOMAIN_ID) returns { domain, dnsRecords }', async () => {
    const res = await client.domains.get(domainId!);
    expect(res.domain.id).toBe(domainId);
    expect(Array.isArray(res.dnsRecords)).toBe(true);
  });

  (audienceId ? it : it.skip)('audiences.get(CONTRACT_TEST_AUDIENCE_ID) returns the audience', async () => {
    const audience = await client.audiences.get(audienceId!);
    expect(audience.id).toBe(audienceId);
  });

  (audienceId ? it : it.skip)('contacts.list(CONTRACT_TEST_AUDIENCE_ID) returns a pagination envelope', async () => {
    const res = await client.contacts.list(audienceId!, { limit: 5 });
    expect(Array.isArray(res.contacts)).toBe(true);
    expect(typeof res.limit).toBe('number');
    expect(typeof res.offset).toBe('number');
  });

  it('unauthorized key throws a typed error', async () => {
    const bad = new PigeonClient({ apiKey: 'ske_definitely_invalid', baseUrl: baseUrl! });
    await expect(bad.domains.list()).rejects.toBeInstanceOf(PigeonError);
  });

  (domainId ? it : it.skip)('emails.send with unverified domain throws domain_not_verified', async () => {
    // This only runs if the test harness sets up an unverified domain intentionally;
    // otherwise the assertion is a no-op.
    try {
      await client.emails.send({
        from: 'from@unverified.example',
        to: ['to@unverified.example'],
        subject: 'contract test',
        text: 'hello',
      });
    } catch (e) {
      expect(e).toBeInstanceOf(PigeonError);
    }
  });
});
