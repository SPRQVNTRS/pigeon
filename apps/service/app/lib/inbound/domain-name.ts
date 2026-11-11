/**
 * Normalise and validate an inbound domain name (a hostname, no wildcard).
 * Lower case, trimmed, without a trailing dot.
 */

export type NormaliseDomainResult = { ok: true; name: string } | { ok: false; message: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TOP_LEVEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const MAX_LENGTH = 253;

export function normaliseInboundDomainName(raw: string): NormaliseDomainResult {
  const name = raw.trim().toLowerCase().replace(/\.$/, '');
  const invalid: NormaliseDomainResult = { ok: false, message: 'name must be a hostname such as reply.example.com' };
  if (name.length === 0 || name.length > MAX_LENGTH) return invalid;

  const labels = name.split('.');
  if (labels.length < 2) return invalid;
  if (!labels.every((label) => LABEL.test(label))) return invalid;
  if (!TOP_LEVEL.test(labels[labels.length - 1] ?? '')) return invalid;
  return { ok: true, name };
}
