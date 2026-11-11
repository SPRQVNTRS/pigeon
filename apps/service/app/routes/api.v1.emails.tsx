/**
 * POST /v1/emails — send an email
 * GET  /v1/emails — list emails
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.emails';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { createEmail, listEmails } from '#app/models/emails.server';
import { getDomainByHostname } from '#app/models/domains.server';
import { checkIdempotency, hashBody, storeIdempotency } from '#app/lib/idempotency';
import { getOrchestrator } from '#app/services/workflows.server';
import { createComponentLogger } from '#app/lib/logger';

const log = createComponentLogger('EmailsRoute');

const SendEmailSchema = z.object({
  from: z.string().regex(
    /^([^@\s]+@[^@\s]+\.[^@\s]+|.+ <[^@\s]+@[^@\s]+\.[^@\s]+>)$/,
    'from must be "email@domain.com" or "Name <email@domain.com>"',
  ),
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  replyTo: z.string().email().optional(),
  subject: z.string().min(1).max(998),
  html: z.string().optional(),
  text: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Set false to keep no html, text or headers in Pigeon once the send is over
   * (reset links, sign-in codes). The recipients, subject and status stay.
   * Default true: other products see no change.
   */
  retain_body: z.boolean().default(true),
});

/** Extract bare email address from "Name <email>" or "email" */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1]! : from.trim();
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { appId } = context.get(apiKeyContext)!;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
  const offset = Number(url.searchParams.get('offset') ?? '0');

  const emailList = await listEmails(appId, { limit, offset });
  return Response.json({ emails: emailList, limit, offset });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { status: 405 });
  }

  const { appId, apiKeyId } = context.get(apiKeyContext)!;

  // Read body once
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }

  // Idempotency check
  const idempotencyKey = request.headers.get('idempotency-key') ?? undefined;
  if (idempotencyKey) {
    const bodyHash = hashBody(rawBody);
    const result = await checkIdempotency(apiKeyId, idempotencyKey, bodyHash);
    if (result.type === 'replay') {
      return Response.json(result.body, { status: result.status, headers: { 'Idempotency-Replayed': 'true' } });
    }
    if (result.type === 'collision') {
      return Response.json(
        { error: { code: 'idempotency_key_collision', message: 'Idempotency key used with different request body' } },
        { status: 409 },
      );
    }
  }

  // Validate
  const parsed = SendEmailSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const fromEmail = extractEmail(body.from);
  const hostname = fromEmail.split('@')[1];

  if (!hostname) {
    return Response.json({ error: { code: 'invalid_request', message: 'Invalid from address' } }, { status: 400 });
  }

  // Domain lookup + status check
  const domain = await getDomainByHostname(hostname, appId);
  if (!domain || domain.dkimStatus !== 'verified') {
    return Response.json(
      { error: { code: 'domain_not_verified', message: `Domain ${hostname} is not verified for sending` } },
      { status: 422 },
    );
  }

  // Persist email row
  const email = await createEmail({
    appId,
    domainId: domain.id,
    apiKeyId,
    fromAddress: body.from,
    toAddresses: body.to,
    ccAddresses: body.cc ?? [],
    bccAddresses: body.bcc ?? [],
    replyTo: body.replyTo,
    subject: body.subject,
    html: body.html,
    text: body.text,
    headers: body.headers ?? {},
    idempotencyKey,
    status: 'queued',
  });

  // Enqueue worker job
  const boss = getOrchestrator().getBoss();
  await boss.send('email.send', {
    emailId: email.id,
    appId,
    domainId: domain.id,
    from: body.from,
    to: body.to,
    cc: body.cc,
    bcc: body.bcc,
    replyTo: body.replyTo,
    subject: body.subject,
    html: body.html,
    text: body.text,
    headers: body.headers,
    retainBody: body.retain_body,
  });

  log.info('Email queued', { emailId: email.id, appId });

  const responseBody = { id: email.id, status: 'queued' };

  // Store idempotency
  if (idempotencyKey) {
    await storeIdempotency(apiKeyId, idempotencyKey, hashBody(rawBody), 201, responseBody);
  }

  return Response.json(responseBody, { status: 201 });
}
