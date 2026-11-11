import { describe, it, expect } from 'vitest';
import { buildEmailReceivedData, pickVerdicts } from '../payload';
import type { InboundMessage } from '../mime';
import type { FromAuthenticationAssessment } from '../authentication';

const MESSAGE: InboundMessage = {
  from: 'customer@example.com',
  subject: 'Re: Antwort',
  text: 'the plain body',
  messageId: '<CAF=abc@mail.example.com>',
  inReplyTo: '<ticket.1@reply.example.test>',
  references: ['<ticket.1@reply.example.test>'],
  attachmentBytesDiscarded: 1234,
  hasSingleFrom: true,
  sesAuthentication: {
    isTrusted: true,
    dkimPassDomains: ['mail.example.com'],
    spfResult: 'pass',
    spfDomain: 'example.net',
    dmarcResult: 'pass',
    dmarcFromDomain: 'example.com',
  },
  autoReply: {
    auto_submitted: 'auto-replied (vacation)',
    precedence: 'bulk',
    auto_response_suppress: null,
    is_auto: true,
  },
};

const ASSESSMENT: FromAuthenticationAssessment = {
  from_authenticated: true,
  authentication: {
    from_domain: 'example.com',
    dkim_pass_domains: ['mail.example.com'],
    dkim_aligned: true,
    spf_domain: 'example.net',
    spf_aligned: false,
    dmarc_pass: true,
    ses_header_trusted: true,
    single_from: true,
  },
};

const ORDERED_AUTHENTICATION = {
  from_domain: 'example.com',
  dkim_pass_domains: ['mail.example.com'],
  dkim_aligned: true,
  spf_domain: 'example.net',
  spf_aligned: false,
  dmarc_pass: true,
  ses_header_trusted: true,
  single_from: true,
};

const ORDERED_AUTO = {
  auto_submitted: 'auto-replied (vacation)',
  precedence: 'bulk',
  auto_response_suppress: null,
  is_auto: true,
};

describe('buildEmailReceivedData', () => {
  it('matches the contract keys, in order: the old keys first, then the new ones appended', () => {
    const data = buildEmailReceivedData({
      recipient: 'kc-k7m2qp.3f9a1c0b@reply.example.test',
      message: MESSAGE,
      verdicts: { dmarc: 'PASS', spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS' },
      assessment: ASSESSMENT,
    });
    expect(JSON.stringify(data)).toBe(
      JSON.stringify({
        recipient: 'kc-k7m2qp.3f9a1c0b@reply.example.test',
        from: 'customer@example.com',
        subject: 'Re: Antwort',
        text: 'the plain body',
        message_id: '<CAF=abc@mail.example.com>',
        in_reply_to: '<ticket.1@reply.example.test>',
        references: ['<ticket.1@reply.example.test>'],
        verdicts: { spf: 'PASS', dkim: 'PASS', spam: 'PASS', virus: 'PASS', dmarc: 'PASS' },
        from_authenticated: true,
        authentication: ORDERED_AUTHENTICATION,
        auto: ORDERED_AUTO,
      }),
    );
    expect(Object.keys(data).slice(0, 10)).toEqual([
      'recipient', 'from', 'subject', 'text', 'message_id', 'in_reply_to', 'references', 'verdicts',
      'from_authenticated', 'authentication',
    ]);
    expect(Object.keys(data).at(-1)).toBe('auto');
  });

  it('writes the auto keys in the fixed order whatever order the caller built', () => {
    const reversed = Object.fromEntries(Object.entries(MESSAGE.autoReply).reverse());
    const data = buildEmailReceivedData({
      recipient: 'r@reply.example.test',
      message: { ...MESSAGE, autoReply: reversed as InboundMessage['autoReply'] },
      verdicts: {},
      assessment: ASSESSMENT,
    });
    expect(JSON.stringify(data.auto)).toBe(JSON.stringify(ORDERED_AUTO));
  });

  it('writes the authentication keys in the fixed order whatever order the caller built', () => {
    const reversed = Object.fromEntries(Object.entries(ASSESSMENT.authentication).reverse());
    const data = buildEmailReceivedData({
      recipient: 'r@reply.example.test',
      message: MESSAGE,
      verdicts: {},
      assessment: { from_authenticated: false, authentication: reversed as FromAuthenticationAssessment['authentication'] },
    });
    expect(JSON.stringify(data.authentication)).toBe(JSON.stringify(ORDERED_AUTHENTICATION));
  });

  it('keeps null ids and an empty references list', () => {
    const data = buildEmailReceivedData({
      recipient: 'r@reply.example.test',
      message: { ...MESSAGE, messageId: null, inReplyTo: null, references: [] },
      verdicts: {},
      assessment: ASSESSMENT,
    });
    expect(data.message_id).toBeNull();
    expect(data.in_reply_to).toBeNull();
    expect(data.references).toEqual([]);
    expect(data.verdicts).toEqual({});
  });
});

describe('pickVerdicts', () => {
  it('keeps only string spf/dkim/spam/virus/dmarc values and omits the rest', () => {
    expect(pickVerdicts({ virus: 'FAIL', spf: 'DISABLED', extra: 'x', dkim: 3 })).toEqual({
      spf: 'DISABLED',
      virus: 'FAIL',
    });
    expect(Object.keys(pickVerdicts({ virus: 'FAIL', spf: 'GRAY' }))).toEqual(['spf', 'virus']);
    expect(pickVerdicts(null)).toEqual({});
    expect(Object.keys(pickVerdicts({ dmarc: 'FAIL', virus: 'PASS', spf: 'PASS' }))).toEqual(['spf', 'virus', 'dmarc']);
  });
});
