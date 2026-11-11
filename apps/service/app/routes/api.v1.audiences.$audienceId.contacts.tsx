/**
 * POST /v1/audiences/:audienceId/contacts — add a contact
 * GET  /v1/audiences/:audienceId/contacts — list contacts
 *
 * Every list answer is { contacts, limit, offset, nextCursor }. `limit` defaults
 * to 100 and is capped at 1000.
 *
 * Default: newest first, `limit` and `offset` query parameters, `nextCursor` is
 * always null. A contact removed during a multi page read shifts the next page,
 * so one contact is missed.
 *
 * Cursor read, `order=id`: ascending id. Start with `order=id` and no `after`,
 * then send `order=id&after=<nextCursor>` until `nextCursor` is null. `nextCursor`
 * is the id of the last row when the page is full, else null, so a full last
 * page is followed by one empty page. `offset` is always 0 here. A contact removed
 * during the read shifts nothing. Ids are random, not time ordered, so a contact
 * added during the read can land behind the cursor and not appear in this read.
 *
 * 400 with the normal error shape: `after` without `order=id`, `offset` with
 * `order=id`, an empty `after`, an `after` over 128 characters or holding a NUL
 * (Postgres text cannot hold one), and with `order=id` a `limit` that is not a
 * positive integer. An `order` other than `id` is ignored, as it always was.
 */
import { z } from 'zod';
import type { Route } from './+types/api.v1.audiences.$audienceId.contacts';
import { apiKeyContext } from '#app/middleware/api-key-context';
import { upsertContact, listContacts, listContactsAfterId } from '#app/models/contacts.server';

const CreateContactSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const MAX_AFTER_LENGTH = 128;

/** The reason this cursor request is invalid, or null when it is fine. Names no value. */
function findCursorParamError(opts: { searchParams: URLSearchParams; limit: number }): string | null {
  const { searchParams, limit } = opts;
  const isIdOrder = searchParams.get('order') === 'id';
  const after = searchParams.get('after');

  if (!isIdOrder) return after === null ? null : 'after requires order=id';
  if (searchParams.has('offset')) return 'offset cannot be combined with order=id';
  // limit=0 would end a cursor read at once, with nothing read and no error.
  if (!Number.isInteger(limit) || limit < 1) return 'limit must be a positive integer with order=id';
  if (after === null) return null;
  // A null cursor sent as `after=` must not restart the read from the top.
  if (after === '') return 'after must not be empty, start a read with order=id and no after';
  if (after.length > MAX_AFTER_LENGTH) return `after must be at most ${MAX_AFTER_LENGTH} characters`;
  if (after.includes('\0')) return 'after must not contain a NUL character';
  return null;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { appId } = context.get(apiKeyContext)!;
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get('limit') ?? '100'), 1000);

  const cursorParamError = findCursorParamError({ searchParams, limit });
  if (cursorParamError) {
    return Response.json({ error: { code: 'invalid_request', message: cursorParamError } }, { status: 400 });
  }

  if (searchParams.get('order') === 'id') {
    const contactList = await listContactsAfterId({
      audienceId: params.audienceId,
      appId,
      limit,
      after: searchParams.get('after'),
    });
    const lastId = contactList.at(-1)?.id ?? null;
    const nextCursor = contactList.length === limit ? lastId : null;
    return Response.json({ contacts: contactList, limit, offset: 0, nextCursor });
  }

  const offset = Number(searchParams.get('offset') ?? '0');
  const contactList = await listContacts(params.audienceId, appId, { limit, offset });
  return Response.json({ contacts: contactList, limit, offset, nextCursor: null });
}

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
  const parsed = CreateContactSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'invalid_request', message: 'Validation error', details: parsed.error.flatten().fieldErrors } },
      { status: 400 },
    );
  }
  const contact = await upsertContact({ appId, audienceId: params.audienceId, ...parsed.data });
  return Response.json({ contact }, { status: 201 });
}
