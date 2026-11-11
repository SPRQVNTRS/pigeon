/**
 * The keyed sender hash and the shared address normaliser. Pure functions, no
 * database. Invented addresses only.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '#config';
import { normalizeAddress } from '#app/lib/email-address';
import {
  deriveSenderHashKey,
  inboundSenderHash,
  senderHashWithSecret,
  SENDER_HASH_PURPOSE,
} from '#app/lib/inbound/sender-hash';

describe('normalizeAddress', () => {
  it.each([
    ['a display name in quotes', '"Jane Doe" <Jane.Doe@Example.COM>', 'jane.doe@example.com'],
    ['a display name without quotes', 'Jane Doe <Jane.Doe@Example.COM>', 'jane.doe@example.com'],
    ['angle brackets only', '<Jane.Doe@Example.COM>', 'jane.doe@example.com'],
    ['spaces inside the brackets', 'Jane < Jane.Doe@Example.COM > ', 'jane.doe@example.com'],
    ['a bare address with spaces', '  Jane.Doe@Example.COM ', 'jane.doe@example.com'],
    ['a bracket inside the quoted name', '"Jane <x> Doe" <jane.doe@example.com>', 'jane.doe@example.com'],
  ])('takes the addr-spec of %s', (_label, input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  it('control: keeps a different address different', () => {
    expect(normalizeAddress('"Jane Doe" <jane.doe@example.com>')).not.toBe(normalizeAddress('john@example.com'));
  });
});

describe('inboundSenderHash', () => {
  it('is HMAC-SHA256 under a purpose key derived from the session secret', () => {
    const purposeKey = createHmac('sha256', CONFIG.session.secret).update(SENDER_HASH_PURPOSE).digest();
    const expected = createHmac('sha256', purposeKey).update('jane.doe@example.com').digest('hex');

    expect(SENDER_HASH_PURPOSE).toBe('inbound-sender-hash-v1');
    expect(inboundSenderHash('jane.doe@example.com')).toBe(expected);
  });

  it('never keys the address hash with the session secret itself', () => {
    const secret = CONFIG.session.secret;
    const keyedWithSecret = createHmac('sha256', secret).update('jane.doe@example.com').digest('hex');

    expect(deriveSenderHashKey(secret).equals(Buffer.from(secret))).toBe(false);
    expect(inboundSenderHash('jane.doe@example.com')).not.toBe(keyedWithSecret);
  });

  it('gives a display-name, mixed-case From the hash of the bare lowercase address', () => {
    expect(inboundSenderHash('"Jane Doe" <Jane.Doe@Example.COM>')).toBe(inboundSenderHash('jane.doe@example.com'));
  });

  it('gives another address another hash, and holds no part of the address', () => {
    const hash = inboundSenderHash('jane.doe@example.com');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(inboundSenderHash('john.doe@example.com'));
  });

  it('changes when the secret changes, so a rotation unlinks older hashes', () => {
    const before = senderHashWithSecret({ address: 'jane.doe@example.com', secret: 'secret-one-example' });
    const after = senderHashWithSecret({ address: 'jane.doe@example.com', secret: 'secret-two-example' });

    expect(before).not.toBe(after);
  });

  it.each(['', '   ', '"Nobody" <>'])('throws on an empty address (%j) without quoting it', (input) => {
    expect(() => inboundSenderHash(input)).toThrow('Cannot hash an empty sender address');
  });
});
