/**
 * The `data` object of an `email.received` delivery. Pure.
 *
 * Contract: docs/inbound-mail.md, `email.received`. Key order is fixed because the body is signed as sent.
 * New keys go at the end only (`from_authenticated`, `authentication`, `auto` came
 * later), so old receivers keep working.
 */

import type { InboundVerdicts } from '#drizzle/schema/inbound';
import type { InboundMessage } from './mime';
import type { FromAuthentication, FromAuthenticationAssessment } from './authentication';
import type { AutoReply } from './auto-reply';

export const EMAIL_RECEIVED_EVENT = 'email.received';

export type EmailReceivedData = {
  recipient: string;
  from: string;
  subject: string;
  text: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  verdicts: InboundVerdicts;
  /** True only when the From domain is proven by DMARC, aligned DKIM or aligned SPF. See ./authentication.ts. */
  from_authenticated: boolean;
  authentication: FromAuthentication;
  /** Auto-reply header values and the verdict. See ./auto-reply.ts. */
  auto: AutoReply;
};

/** `dmarc` last: it came later, and rows from before it have none. */
const VERDICT_KEYS = ['spf', 'dkim', 'spam', 'virus', 'dmarc'] as const;

/** Only the verdicts SES provided, as strings, in a fixed key order. */
export function pickVerdicts(raw: unknown): InboundVerdicts {
  const verdicts: InboundVerdicts = {};
  if (!raw || typeof raw !== 'object') return verdicts;
  const source = raw as Record<string, unknown>;
  for (const key of VERDICT_KEYS) {
    const value = source[key];
    if (typeof value === 'string') verdicts[key] = value;
  }
  return verdicts;
}

/** A copy in the fixed key order, whatever order the caller built. */
function orderAuthentication(source: FromAuthentication): FromAuthentication {
  return {
    from_domain: source.from_domain,
    dkim_pass_domains: [...source.dkim_pass_domains],
    dkim_aligned: source.dkim_aligned,
    spf_domain: source.spf_domain,
    spf_aligned: source.spf_aligned,
    dmarc_pass: source.dmarc_pass,
    ses_header_trusted: source.ses_header_trusted,
    single_from: source.single_from,
  };
}

/** A copy in the fixed key order, whatever order the caller built. */
function orderAutoReply(source: AutoReply): AutoReply {
  return {
    auto_submitted: source.auto_submitted,
    precedence: source.precedence,
    auto_response_suppress: source.auto_response_suppress,
    is_auto: source.is_auto,
  };
}

export function buildEmailReceivedData(opts: {
  recipient: string;
  message: InboundMessage;
  verdicts: unknown;
  assessment: FromAuthenticationAssessment;
}): EmailReceivedData {
  const { recipient, message, assessment } = opts;
  return {
    recipient,
    from: message.from,
    subject: message.subject,
    text: message.text,
    message_id: message.messageId,
    in_reply_to: message.inReplyTo,
    references: [...message.references],
    verdicts: pickVerdicts(opts.verdicts),
    from_authenticated: assessment.from_authenticated,
    authentication: orderAuthentication(assessment.authentication),
    auto: orderAutoReply(message.autoReply),
  };
}
