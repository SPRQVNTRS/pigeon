/**
 * POST /v1/audiences/:audienceId/contacts/bulk — bulk upsert contacts
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.audiences.$audienceId.contacts.bulk';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { bulkUpsertContacts } from '#app/models/contacts.server';

const ContactItemSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const BulkContactSchema = z.object({
  contacts: z.array(ContactItemSchema).min(1).max(100),
});

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { status: 405 });
  }
  const { appId } = context.get(apiKeyContext)!;
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
  }
  const parsed = BulkContactSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
      { status: 400 },
    );
  }
  const upserted = await bulkUpsertContacts(appId, params.audienceId, parsed.data.contacts);
  return Response.json({ count: upserted.length, contacts: upserted }, { status: 201 });
}
