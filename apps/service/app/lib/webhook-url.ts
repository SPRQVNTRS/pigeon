export type NormaliseWebhookUrlResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

const IPV4_DOTTED = /^\d{1,3}(\.\d{1,3}){3}$/;

function isLocalhostName(hostname: string): boolean {
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  return name === 'localhost' || name.endsWith('.localhost');
}

/**
 * Validate and normalise a webhook endpoint URL.
 *
 * Rules: parses with WHATWG URL, https only, no userinfo, no localhost or
 * `*.localhost`, no IP literal, fragment dropped. The WHATWG parser already
 * lowercases the host, drops the default port and rewrites numeric IPv4 forms
 * (`2130706433`, `0x7f.1`) to dotted form, so one dotted check covers them.
 * The returned `href` is the canonical form stored and compared for
 * uniqueness. Path, query and trailing slash are kept as given.
 *
 * Syntactic checks only. Hostnames that resolve to private addresses are
 * checked in lib/webhook-target.ts, at registration and on every delivery.
 */
export function normaliseWebhookUrl(raw: string): NormaliseWebhookUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, message: 'Must be a valid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, message: 'Must be an HTTPS URL' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, message: 'URL must not contain a username or password' };
  }
  if (isLocalhostName(parsed.hostname)) {
    return { ok: false, message: 'URL must not point to localhost' };
  }
  if (parsed.hostname.startsWith('[') || IPV4_DOTTED.test(parsed.hostname)) {
    return { ok: false, message: 'URL must use a hostname, not an IP address' };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.href };
}
