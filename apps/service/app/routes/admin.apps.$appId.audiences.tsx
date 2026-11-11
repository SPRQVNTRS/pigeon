import type { Route } from './+types/admin.apps.$appId.audiences';
import { Link, Form, useActionData } from 'react-router';
import { redirect } from 'react-router';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { z } from 'zod';
import { Users } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { listAudiences, createAudience } from '#app/models/audiences.server';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';
import { withConfigChange } from '#app/models/config-change.server';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';
import { db } from '#drizzle/db';
import { contacts } from '#drizzle/schema/index';
import { eq, count } from 'drizzle-orm';

export const handle = { title: 'Audiences' };

const createSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().max(500).optional(),
});

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [audienceList, app, countRows] = await Promise.all([
    listAudiences(params.appId),
    getAppById(params.appId),
    db
      .select({ audienceId: contacts.audienceId, count: count() })
      .from(contacts)
      .where(eq(contacts.appId, params.appId))
      .groupBy(contacts.audienceId),
  ]);

  const countMap = new Map(countRows.map((r) => [r.audienceId, r.count]));

  const audiences = audienceList.map((a) => ({
    ...a,
    contactCount: countMap.get(a.id) ?? 0,
  }));

  return { user, appId: params.appId, audiences, app };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  getUser(context); // auth guard
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: createSchema });

  if (submission.status !== 'success') {
    return submission.reply();
  }

  try {
    // A configuration write: unconditional (the form sends no state version), but it bumps it.
    const { result: audience } = await withConfigChange({
      appId: params.appId,
      expectedVersion: null,
      run: (tx) =>
        createAudience(
          {
            appId: params.appId,
            name: submission.value.name,
            description: submission.value.description || undefined,
          },
          tx,
        ),
    });
    return redirect(`/admin/apps/${params.appId}/audiences/${audience.id}/contacts`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unique') || msg.includes('audiences')) {
      return submission.reply({ fieldErrors: { name: ['An audience with this name already exists'] } });
    }
    throw err;
  }
}

export default function AdminAppAudiences({ loaderData }: Route.ComponentProps) {
  const { user, appId, audiences, app } = loaderData;
  const actionData = useActionData<typeof action>();
  const [form, fields] = useForm({
    lastResult: actionData && 'status' in actionData ? actionData : null,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: createSchema });
    },
    shouldValidate: 'onBlur',
  });

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Audiences
          </h1>
          <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
            Audiences are mailing lists. Contacts are the subscribers in each list.
          </p>
        </div>

        {/* Create form */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">
            New Audience
          </h2>
          <Form method="post" {...getFormProps(form)} className="space-y-4">
            <div>
              <Label
                htmlFor={fields.name.id}
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Name
              </Label>
              <Input
                {...getInputProps(fields.name, { type: 'text' })}
                placeholder="e.g. Newsletter, Announcements"
              />
              {fields.name.errors && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  {fields.name.errors[0]}
                </p>
              )}
            </div>
            <div>
              <Label
                htmlFor={fields.description.id}
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Description{' '}
                <span className="text-zinc-400 font-normal">(optional)</span>
              </Label>
              <Input
                {...getInputProps(fields.description, { type: 'text' })}
                placeholder="Short description"
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm">
                Create Audience
              </Button>
            </div>
          </Form>
        </div>

        {/* Audiences table */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          {audiences.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm font-medium text-zinc-500">No audiences yet</p>
              <p className="text-xs text-zinc-400 mt-1">
                Create an audience to start managing mailing lists.
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Description
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Contacts
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500" />
                </tr>
              </thead>
              <tbody>
                {audiences.map((audience) => (
                  <tr
                    key={audience.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {audience.name}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs">
                      {audience.description ?? '-'}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-700 dark:text-zinc-300">
                      {audience.contactCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 tabular-nums">
                      {new Date(audience.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/apps/${appId}/audiences/${audience.id}/contacts`}
                        className="text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                      >
                        View contacts
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
