/**
 * GET    /v1/audiences/:audienceId/contacts/:id — get a contact
 * PATCH  /v1/audiences/:audienceId/contacts/:id — update a contact; `status: 'subscribed'` re-subscribes (409 contact_suppressed if bounced/complained/suppressed)
 * DELETE /v1/audiences/:audienceId/contacts/:id — unsubscribe a contact
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.audiences.$audienceId.contacts.$id';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { ContactSuppressedError, getContact, updateContact, unsubscribeContact } from '#app/models/contacts.server';

const UpdateContactSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  // Re-subscribe only. Unsubscribing is DELETE; bounced and complained are set by SES events.
  status: z.literal('subscribed').optional(),
});

export async function loader({ params, context }: Route.LoaderArgs) {
  const { appId } = context.get(apiKeyContext)!;
  const contact = await getContact(params.id, appId);
  if (!contact) {
    return Response.json({ error: { code: 'not_found', message: 'Contact not found' } }, { status: 404 });
  }
  return Response.json({ contact });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { appId } = context.get(apiKeyContext)!;
  if (request.method === 'DELETE') {
    const contact = await getContact(params.id, appId);
    if (!contact) {
      return Response.json({ error: { code: 'not_found', message: 'Contact not found' } }, { status: 404 });
    }
    await unsubscribeContact(params.audienceId, contact.email, appId);
    return Response.json({ success: true, status: 'unsubscribed' });
  }
  if (request.method === 'PATCH') {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return Response.json({ error: { code: 'invalid_request', message: 'Invalid JSON body' } }, { status: 400 });
    }
    const parsed = UpdateContactSchema.safeParse(rawBody);
    if (!parsed.success) {
      return Response.json(
        { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
        { status: 400 },
      );
    }
    let contact: Awaited<ReturnType<typeof updateContact>>;
    try {
      contact = await updateContact(params.id, appId, parsed.data);
    } catch (error) {
      if (!(error instanceof ContactSuppressedError)) throw error;
      return Response.json(
        { error: { code: 'contact_suppressed', message: 'Contact bounced, complained or is suppressed and cannot be re-subscribed' } },
        { status: 409 },
      );
    }
    if (!contact) {
      return Response.json({ error: { code: 'not_found', message: 'Contact not found' } }, { status: 404 });
    }
    return Response.json({ contact });
  }
  return Response.json({ error: { code: 'method_not_allowed', message: 'Method not allowed' } }, { status: 405 });
}
