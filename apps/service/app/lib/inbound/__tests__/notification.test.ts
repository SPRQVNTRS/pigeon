import { describe, it, expect } from 'vitest';
import { parseInboundNotification, InvalidInboundNotificationError } from '../notification';
import { receiptNotification, SAMPLE } from '../../../../test/support/inbound-fixtures';

describe('parseInboundNotification', () => {
  it('reads id, time, recipients, verdicts and the S3 location', () => {
    const receipt = parseInboundNotification(JSON.stringify(receiptNotification()));
    expect(receipt).toEqual({
      sesMessageId: 'ses-message-0001',
      receivedAt: new Date('2026-11-09T10:00:00.000Z'),
      recipients: [SAMPLE.recipient],
      verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS' },
      s3: { bucket: 'example-pigeon-inbound', key: 'incoming/test/ses-message-0001' },
    });
  });

  it('reads dmarcVerdict into verdicts.dmarc', () => {
    const receipt = parseInboundNotification(
      JSON.stringify(receiptNotification({ verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' } })),
    );
    expect(receipt.verdicts).toEqual({ spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' });
  });

  it('keeps verdict values exactly as SES wrote them and omits missing ones', () => {
    const receipt = parseInboundNotification(
      JSON.stringify(receiptNotification({ verdicts: { spf: 'GRAY', virus: 'PROCESSING_FAILED' } })),
    );
    expect(receipt.verdicts).toEqual({ spf: 'GRAY', virus: 'PROCESSING_FAILED' });
    expect('dkim' in receipt.verdicts).toBe(false);
    expect('dmarc' in receipt.verdicts).toBe(false);
  });

  it('rejects non-JSON, a bounce notification and a non-S3 action without quoting the input', () => {
    expect(() => parseInboundNotification('not json')).toThrow(InvalidInboundNotificationError);

    const bounce = { ...receiptNotification(), notificationType: 'Bounce' };
    expect(() => parseInboundNotification(JSON.stringify(bounce))).toThrow(/notificationType/);

    const sns = receiptNotification();
    (sns.receipt as Record<string, unknown>).action = { type: 'SNS', topicArn: 'x' };
    let message = '';
    try {
      parseInboundNotification(JSON.stringify(sns));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/receipt\.action/);
    expect(message).not.toContain(SAMPLE.recipient);
    expect(message).not.toContain(SAMPLE.subject);
  });

  it('rejects an empty recipient list and an invalid timestamp', () => {
    expect(() => parseInboundNotification(JSON.stringify(receiptNotification({ recipients: [] })))).toThrow(
      /receipt\.recipients/,
    );
    const badTime = receiptNotification();
    (badTime.mail as Record<string, unknown>).timestamp = 'yesterday';
    expect(() => parseInboundNotification(JSON.stringify(badTime))).toThrow(/mail\.timestamp/);
  });
});
