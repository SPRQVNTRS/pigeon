/**
 * MIME parser for DMARC report emails.
 *
 * Extracts DMARC XML attachment(s) from a raw email (MIME) buffer.
 * Uses mailparser for MIME parsing and detects attachment format by magic bytes.
 *
 * Format detection (not Content-Type — providers get it wrong):
 *   [0x1f, 0x8b]             → gzip
 *   [0x50, 0x4b, 0x03, 0x04] → zip (PK signature)
 *   otherwise                → plain XML / attempt parse directly
 *
 * Decompressed output is capped at DMARC_MAX_DECOMPRESSED_BYTES per attachment.
 * The caller caps the raw mail (see app/lib/dmarc/sns-dmarc.ts).
 */

import { simpleParser } from 'mailparser';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { unzipSync, type UnzipFileInfo } from 'fflate';

const gunzipAsync = promisify(gunzip);

// =============================================================================
// Magic byte detection
// =============================================================================

type AttachmentFormat = 'gzip' | 'zip' | 'xml';

function detectFormat(buf: Buffer): AttachmentFormat {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return 'gzip';
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  ) {
    return 'zip';
  }
  return 'xml';
}

// =============================================================================
// Decompression
// =============================================================================

/**
 * Most bytes one attachment may decompress to. A real aggregate report is a
 * few KB to a few MB of XML; anything larger is a decompression bomb.
 */
export const DMARC_MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;

/** An attachment decompresses past DMARC_MAX_DECOMPRESSED_BYTES. Permanent. */
export class DmarcAttachmentTooLargeError extends Error {
  constructor(reason: string) {
    super(`DMARC attachment over the ${DMARC_MAX_DECOMPRESSED_BYTES} byte cap: ${reason}`);
    this.name = 'DmarcAttachmentTooLargeError';
  }
}

function isBufferTooLarge(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ERR_BUFFER_TOO_LARGE';
}

async function gunzipCapped(buf: Buffer): Promise<Buffer> {
  try {
    return await gunzipAsync(buf, { maxOutputLength: DMARC_MAX_DECOMPRESSED_BYTES });
  } catch (err) {
    if (isBufferTooLarge(err)) throw new DmarcAttachmentTooLargeError('gzip output');
    throw err;
  }
}

/**
 * List the entries of a zip from its central directory. Nothing is inflated.
 */
function listZipEntries(data: Uint8Array): UnzipFileInfo[] {
  const entries: UnzipFileInfo[] = [];
  unzipSync(data, {
    filter: (file) => {
      entries.push(file);
      return false;
    },
  });
  return entries;
}

/**
 * Inflate the one report entry of a zip, with its size checked twice: the
 * declared size before inflating (fflate allocates that many bytes up front),
 * and the actual output after. Only that entry is inflated, so the total
 * output is capped at DMARC_MAX_DECOMPRESSED_BYTES too.
 */
function unzipReportEntry(buf: Buffer): Uint8Array {
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = listZipEntries(data);
  const xmlIndex = entries.findIndex((entry) => entry.name.toLowerCase().endsWith('.xml'));
  const targetIndex = xmlIndex >= 0 ? xmlIndex : 0;
  const target = entries[targetIndex];
  if (!target) throw new Error('ZIP archive is empty');
  if (target.originalSize > DMARC_MAX_DECOMPRESSED_BYTES) {
    throw new DmarcAttachmentTooLargeError('zip entry declared size');
  }

  // Select by position, not name: two entries may share a name.
  let index = -1;
  const files = unzipSync(data, {
    filter: () => {
      index += 1;
      return index === targetIndex;
    },
  });
  const output = files[target.name];
  if (!output) throw new Error('ZIP entry could not be read');
  if (output.length > DMARC_MAX_DECOMPRESSED_BYTES) {
    throw new DmarcAttachmentTooLargeError('zip entry output');
  }
  return output;
}

/**
 * Decompress / decode an attachment buffer into an XML string.
 *
 * Detects format by magic bytes (gzip / zip / plain XML).
 * For zip archives, extracts the first entry whose name ends with `.xml`,
 * else the first entry.
 *
 * @throws DmarcAttachmentTooLargeError when the output would pass
 *   DMARC_MAX_DECOMPRESSED_BYTES
 * @throws if decompression fails or the zip is empty
 */
export async function decompressAttachment(buf: Buffer): Promise<string> {
  const format = detectFormat(buf);
  if (format === 'gzip') return (await gunzipCapped(buf)).toString('utf8');
  if (format === 'zip') return Buffer.from(unzipReportEntry(buf)).toString('utf8');
  return buf.toString('utf8');
}

// =============================================================================
// MIME extraction
// =============================================================================

/**
 * Parse a raw email buffer (MIME) and return all attachment/inline buffers
 * that could be DMARC reports (gzip, zip, or XML content).
 *
 * Falls back to the full email text body if no attachments are found
 * (some providers send the XML inline without attachment headers).
 */
export async function extractDmarcAttachments(rawEmail: Buffer): Promise<Buffer[]> {
  const parsed = await simpleParser(rawEmail);
  const results: Buffer[] = [];

  if (parsed.attachments && parsed.attachments.length > 0) {
    for (const att of parsed.attachments) {
      const content = att.content;
      if (!content || content.length === 0) continue;

      // Include if magic bytes suggest a known format, or content type is xml/gzip/zip
      const format = detectFormat(content);
      const ct = (att.contentType ?? '').toLowerCase();
      const isKnownType =
        format !== 'xml' ||
        ct.includes('xml') ||
        ct.includes('gzip') ||
        ct.includes('zip') ||
        ct === 'application/octet-stream';

      if (isKnownType) {
        results.push(content);
      }
    }
  }

  // Inline XML fallback: if no attachment produced but the email text looks like XML
  if (results.length === 0 && parsed.text) {
    const trimmed = parsed.text.trim();
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<feedback')) {
      results.push(Buffer.from(trimmed, 'utf8'));
    }
  }

  return results;
}
