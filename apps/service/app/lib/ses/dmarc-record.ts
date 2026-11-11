/**
 * The DMARC TXT value a tenant domain publishes. Pure and import-free, so the
 * admin UI route can render it without pulling server settings into the client.
 */

/**
 * `"v=DMARC1; p=none; rua=mailto:<rua>"`, or `"v=DMARC1; p=none"` when no
 * report address is configured (PIGEON_DMARC_RUA unset). Both are valid records.
 */
export function buildDmarcRecordValue(rua: string | undefined): string {
  if (!rua) return '"v=DMARC1; p=none"';
  return `"v=DMARC1; p=none; rua=mailto:${rua}"`;
}
