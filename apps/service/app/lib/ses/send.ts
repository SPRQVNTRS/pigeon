/**
 * SES raw email sender.
 *
 * Assembles a MIME message via nodemailer (streamTransport: true — nodemailer
 * is used only for MIME assembly, not as a mail transport) and sends it via
 * SES SendEmailCommand with Content.Raw.Data containing the raw MIME buffer.
 */

import nodemailer from 'nodemailer';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { getSesClient } from './client';
import { CONFIG } from '#config';

export interface Attachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface SendEmailOptions {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  configurationSet?: string;
  tags?: Array<{ name: string; value: string }>;
  region?: string;
}

export interface SendEmailResult {
  messageId: string;
}

/**
 * Assemble a MIME message via nodemailer and send it via SES
 * using SendEmailCommand with Content: { Raw: { Data: buffer } }.
 */
export async function sendEmail({
  from,
  to,
  subject,
  html,
  text,
  cc,
  bcc,
  replyTo,
  attachments,
  headers,
  configurationSet = CONFIG.aws.sesConfigSet,
  tags,
  region,
}: SendEmailOptions): Promise<SendEmailResult> {
  const rawData = await buildMimeBuffer({
    from,
    to,
    subject,
    html,
    text,
    cc,
    bcc,
    replyTo,
    attachments,
    headers,
  });

  const client = getSesClient(region);
  const response: SendEmailCommandOutput = await client.send(
    new SendEmailCommand({
      Content: {
        Raw: { Data: rawData },
      },
      ConfigurationSetName: configurationSet,
      EmailTags: tags?.map((t) => ({ Name: t.name, Value: t.value })),
    }),
  );

  return { messageId: response.MessageId ?? '' };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface MimeOptions {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
}

async function buildMimeBuffer(opts: MimeOptions): Promise<Uint8Array> {
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });

  const info = await transport.sendMail({
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    replyTo: opts.replyTo,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    headers: opts.headers,
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    // @ts-expect-error nodemailer stream transport returns a stream in info.message
    info.message.on('data', (chunk: Buffer) => chunks.push(chunk));
    // @ts-expect-error same
    info.message.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    // @ts-expect-error same
    info.message.on('error', reject);
  });
}
