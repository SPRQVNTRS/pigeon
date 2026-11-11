import type { Route } from './+types/admin.apps.new';
import type { SubmissionResult } from '@conform-to/react';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { Form, redirect, useActionData, Link } from 'react-router';
import { z } from 'zod';
import AdminShell from '#app/components/admin-shell';
import { createApp } from '#app/models/apps.server';
import { AppNameTakenError } from '#app/lib/app-name-taken';
import { getUser } from '#app/middleware/helpers';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
});

export const handle = { title: 'New App' };

export async function loader({ context }: Route.LoaderArgs) {
  const user = getUser(context);
  return { user };
}

export async function action({ request, context }: Route.ActionArgs) {
  // The admin role is checked by the _admin-ui layout middleware.
  getUser(context);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });
  if (submission.status !== 'success') {
    return submission.reply();
  }
  try {
    const app = await createApp({ name: submission.value.name });
    return redirect(`/admin/apps/${app.id}?created=1`);
  } catch (err) {
    if (!(err instanceof AppNameTakenError)) throw err;
    return submission.reply({ fieldErrors: { name: ['An app with this name already exists'] } });
  }
}

export default function AdminAppsNew({ loaderData }: Route.ComponentProps) {
  const { user } = loaderData;
  const lastResult = useActionData<typeof action>() as SubmissionResult | undefined;
  const [form, fields] = useForm({
    lastResult,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
    shouldValidate: 'onBlur',
  });

  return (
    <AdminShell user={user}>
      <div className="max-w-md space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          New App
        </h1>

        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <Form method="post" {...getFormProps(form)} className="space-y-5">
            <div>
              <Label
                htmlFor={fields.name.id}
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                App Name
              </Label>
              <Input
                {...getInputProps(fields.name, { type: 'text' })}
                placeholder="e.g. my-app"
                className={fields.name.errors ? 'border-red-500 focus-visible:ring-red-500/20' : ''}
              />
              {fields.name.errors && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  {fields.name.errors}
                </p>
              )}
              <p className="mt-1.5 text-xs text-zinc-500">
                A unique name for this application. Cannot be changed later.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-1">
              <Button type="button" variant="outline" asChild size="sm">
                <Link to="/admin/apps">Cancel</Link>
              </Button>
              <Button type="submit" size="sm">
                Create App
              </Button>
            </div>
          </Form>
        </div>
      </div>
    </AdminShell>
  );
}
