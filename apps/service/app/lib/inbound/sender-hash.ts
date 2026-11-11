/**
 * Keyed hash of the sender (From) of a received mail.
 *
 * `inbound_emails` never holds the sender address. It holds this hash, so the
 * recipient erase can find a person's received mail by their address and
 * nothing else can read the address back out of the table.
 *
 * Key: a purpose key derived from SESSION_SECRET, never the session secret
 * itself, so the session key and the hash key are never the same value:
 *
 *   purposeKey = HMAC-SHA256(SESSION_SECRET, "inbound-sender-hash-v1")
 *   senderHash = hex(HMAC-SHA256(purposeKey, normalizeAddress(from)))
 *
 * A SESSION_SECRET rotation changes every hash. Rows hashed under the old
 * secret then no longer match an erase, until retention deletes them (under
 * 7 days). See docs/inbound-mail.md, "Recipient erase".
 */
import { createHmac } from 'node:crypto';
import { CONFIG } from '#config';
import { normalizeAddress } from '#app/lib/email-address';

/** Domain separation for the purpose key. Bump the version to re-key. */
export const SENDER_HASH_PURPOSE = 'inbound-sender-hash-v1';

/** Derive the hash key from a secret. Exported for the tests only. */
export function deriveSenderHashKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(SENDER_HASH_PURPOSE).digest();
}

/**
 * Hash one address under an explicit secret. Throws on an empty address: an
 * empty From would give one hash shared by every mail without a sender. The
 * error never quotes the input.
 */
export function senderHashWithSecret(opts: { address: string; secret: string }): string {
  const normalized = normalizeAddress(opts.address);
  if (normalized === '') throw new Error('Cannot hash an empty sender address');
  return createHmac('sha256', deriveSenderHashKey(opts.secret)).update(normalized).digest('hex');
}

/** The hash stored in `inbound_emails.sender_hash`, under CONFIG.session.secret. */
export function inboundSenderHash(address: string): string {
  return senderHashWithSecret({ address, secret: CONFIG.session.secret });
}
