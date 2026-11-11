import type { Route } from './+types/admin.apps.$appId.audiences.$audienceId.contacts';
import { Link, Form } from 'react-router';
import { redirect } from 'react-router';
import { Users } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { getAudience } from '#app/models/audiences.server';
import { listContacts, unsubscribeContact } from '#app/models/contacts.server';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';

export const handle = { title: 'Contacts' };

const PAGE_SIZE = 50;

type ContactStatus = 'subscribed' | 'unsubscribed' | string;

function ContactStatusPill({ status }: { status: ContactStatus }) {
  const isSubscribed = status === 'subscribed';
  const classes = isSubscribed
    ? 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30'
    : 'bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-500/30';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${classes}`}>
      {isSubscribed ? 'Subscribed' : 'Unsubscribed'}
    </span>
  );
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const user = getUser(context);

  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const offset = (page - 1) * PAGE_SIZE;

  const [audience, app, contacts] = await Promise.all([
    getAudience(params.audienceId, params.appId),
    getAppById(params.appId),
    listContacts(params.audienceId, params.appId, { limit: PAGE_SIZE, offset }),
  ]);

  if (!audience) {
    throw new Response('Not Found', { status: 404 });
  }

  return {
    user,
    appId: params.appId,
    audience,
    app,
    contacts,
    page,
    hasMore: contacts.length === PAGE_SIZE,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  getUser(context); // auth guard

  const formData = await request.formData();
  const intent = formData.get('intent');
  const email = formData.get('email') as string | null;

  if (intent === 'unsubscribe' && email) {
    await unsubscribeContact(params.audienceId, email, params.appId);
    const url = new URL(request.url);
    const page = url.searchParams.get('page') ?? '1';
    return redirect(
      `/admin/apps/${params.appId}/audiences/${params.audienceId}/contacts?page=${page}&unsubscribed=1`,
    );
  }

  return redirect(`/admin/apps/${params.appId}/audiences/${params.audienceId}/contacts`);
}

export default function AdminAudienceContacts({ loaderData }: Route.ComponentProps) {
  const { user, appId, audience, app, contacts, page, hasMore } = loaderData;
  const showFrom = (page - 1) * PAGE_SIZE + 1;
  const showTo = (page - 1) * PAGE_SIZE + contacts.length;

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {audience.name}
          </h1>
          {audience.description && (
            <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
              {audience.description}
            </p>
          )}
        </div>

        {/* Contacts table */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          {contacts.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-100 dark:border-zinc-800">
              <span className="text-xs text-zinc-500 tabular-nums">
                {`Showing ${showFrom} to ${showTo}`}
                {page > 1 && ` · Page ${page}`}
              </span>
            </div>
          )}

          {contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm font-medium text-zinc-500">No contacts yet</p>
              <p className="text-xs text-zinc-400 mt-1">
                Use the API to add contacts to this audience.
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Email
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Subscribed
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500" />
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr
                    key={contact.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-4 py-3 text-zinc-900 dark:text-zinc-100 text-xs font-mono">
                      {contact.email}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">
                      {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <ContactStatusPill status={contact.status ?? 'subscribed'} />
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs tabular-nums">
                      {new Date(contact.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {contact.status === 'subscribed' && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="unsubscribe" />
                          <input type="hidden" name="email" value={contact.email} />
                          <button
                            type="submit"
                            className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                            onClick={(e) => {
                              if (!window.confirm(`Unsubscribe ${contact.email}?`)) e.preventDefault();
                            }}
                          >
                            Unsubscribe
                          </button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {(page > 1 || hasMore) && (
          <div className="flex items-center gap-4">
            {page > 1 && (
              <Link
                to={`/admin/apps/${appId}/audiences/${audience.id}/contacts?page=${page - 1}`}
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
              >
                ← Previous
              </Link>
            )}
            {hasMore && (
              <Link
                to={`/admin/apps/${appId}/audiences/${audience.id}/contacts?page=${page + 1}`}
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
              >
                Next →
              </Link>
            )}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
