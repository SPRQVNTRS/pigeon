/**
 * The SubscribeURL guard shared by the three SNS routes (ses, dmarc, inbound).
 *
 * A SubscriptionConfirmation carries a URL that the route GETs to confirm the
 * subscription. The URL is part of the signed string, so a forged message
 * fails the signature first; this check is defence in depth, so the service
 * never fetches a URL that SNS itself would not issue. Each route also checks
 * the topic ARN before it verifies or fetches anything.
 */

/** Host of a SubscribeURL that SNS itself issues, e.g. sns.eu-central-1.amazonaws.com. */
const SNS_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

/** True for an https URL on an SNS host, on the default port, with no user name or password. */
export function isSnsSubscribeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  return SNS_HOST_PATTERN.test(url.hostname);
}
