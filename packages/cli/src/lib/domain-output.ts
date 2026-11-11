import type { PigeonDnsRecord } from './types.js';
import { formatTable } from './formatters.js';
import { type MailRouting, mergedSpfValue, receivesMailElsewhere } from './mail-routing.js';

function isMxRecord(record: PigeonDnsRecord): boolean {
  return record.type.toUpperCase() === 'MX';
}

/** The API quotes TXT values (`"v=spf1 ..."`), so strip them before the prefix test. */
function isSpfRecord(record: PigeonDnsRecord): boolean {
  return record.type.toUpperCase() === 'TXT' && record.value.replace(/^"/, '').startsWith('v=spf1');
}

function resolveDisplayValue(opts: { record: PigeonDnsRecord; routing: MailRouting }): string {
  if (!receivesMailElsewhere(opts.routing)) return opts.record.value;
  if (isMxRecord(opts.record)) {
    return 'SKIP, the domain receives mail elsewhere; keep the existing MX record';
  }
  if (isSpfRecord(opts.record)) {
    return mergedSpfValue(opts.routing);
  }
  return opts.record.value;
}

/**
 * Prints DNS records as an aligned table. When the domain receives mail
 * elsewhere (per its live MX), the MX row is annotated as SKIP (existing MX
 * wins) and the SPF row shows the one merged record instead of pigeon's
 * standalone SPF value. The `notes` field from the API is always shown as-is.
 */
export function formatDnsRecordsTable(opts: { records: PigeonDnsRecord[]; routing: MailRouting }): string {
  if (opts.records.length === 0) return '  No DNS records returned.';

  const rows = opts.records.map((record) => [
    record.type,
    record.host,
    resolveDisplayValue({ record, routing: opts.routing }),
    String(record.ttl),
    record.notes ?? '',
  ]);

  return formatTable(['Type', 'Host', 'Value', 'TTL', 'Notes'], rows, {
    align: ['left', 'left', 'left', 'right', 'left'],
  });
}

export function printDnsRecordsTable(opts: { records: PigeonDnsRecord[]; routing: MailRouting }): void {
  console.log(formatDnsRecordsTable(opts));
}
