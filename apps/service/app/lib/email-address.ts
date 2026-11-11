/**
 * One shape for an email address in every comparison Pigeon makes about a
 * person: the addr-spec only, trimmed, lowercase.
 *
 * Shared by the recipient erase (the address in the request) and by
 * inbound.process (the From of a received mail, see
 * app/lib/inbound/sender-hash.ts). Both sides must agree byte for byte, or the
 * erase cannot find the hash the worker wrote.
 */

/** The angle-addr at the end of a mailbox: `Name <addr>`. */
const TRAILING_ANGLE_ADDR = /<([^<>]*)>\s*$/;

/**
 * `"Jane Doe" <Jane.Doe@Example.COM>` and ` jane.doe@example.com ` both give
 * `jane.doe@example.com`. A value with no angle brackets is taken whole.
 * Never validates: callers that need a real address check it first.
 */
export function normalizeAddress(value: string): string {
  const addrSpec = TRAILING_ANGLE_ADDR.exec(value)?.[1] ?? value;
  return addrSpec.trim().toLowerCase();
}
