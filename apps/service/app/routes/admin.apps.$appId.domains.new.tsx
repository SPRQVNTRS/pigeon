import type { Route } from './+types/admin.apps.$appId.domains.new';
import type { SubmissionResult } from '@conform-to/react';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { Form, redirect, useActionData, Link } from 'react-router';
import { z } from 'zod';
import AdminShell from '#app/components/admin-shell';
import { createDomain } from '#app/services/domain-service';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';
import { getOrchestrator } from '#app/services/workflows.server';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';

const FQDN_REGEX = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63}(?<!-))+$/;

const schema = z.object({
  name: z
    .string()
    .min(1, 'Domain is required')
    .max(253, 'Domain name is too long')
    .regex(FQDN_REGEX, 'Must be a valid domain (e.g. example.com)'),
});

export const handle = { title: 'Add Domain' };

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const app = await getAppById(params.appId);
  return { user, appId: params.appId, app };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  getUser(context); // auth check — _admin-ui layout already validates, but defense-in-depth

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });
  if (submission.status !== 'success') {
    return submission.reply();
  }

  try {
    const boss = getOrchestrator().getBoss();
    // Unconditional (the form sends no state version), but it bumps it.
    const { domain } = await createDomain({
      appId: params.appId,
      name: submission.value.name,
      expectedVersion: null,
      boss,
    });
    return redirect(`/admin/apps/${params.appId}/domains/${domain.id}?created=1`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Unique constraint on domain name (uniqueIndex('domains_name_idx'))
    if (message.includes('unique') || message.includes('domains_name_idx')) {
      return submission.reply({
        fieldErrors: { name: ['Domain already registered in this system'] },
      });
    }
    return submission.reply({
      formErrors: [`Failed to create domain: ${message}`],
    });
  }
}

export default function AdminAppDomainsNew({ loaderData }: Route.ComponentProps) {
  const { user, appId, app } = loaderData;
  const lastResult = useActionData<typeof action>() as SubmissionResult | undefined;
  const [form, fields] = useForm({
    lastResult,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
    shouldValidate: 'onBlur',
  });

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="max-w-md space-y-6">
        <h2 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Add Domain</h2>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-6">
          {form.errors && form.errors.length > 0 && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {form.errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}
          <Form method="post" {...getFormProps(form)} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor={fields.name.id}>Domain Name</Label>
              <Input
                {...getInputProps(fields.name, { type: 'text' })}
                placeholder="e.g. example.com"
                className={fields.name.errors ? 'border-red-500' : ''}
              />
              {fields.name.errors && (
                <p className="text-sm text-red-500">{fields.name.errors}</p>
              )}
              <p className="text-xs text-zinc-500">
                Enter the bare domain (no https:// prefix). SES will generate DKIM records for you.
              </p>
            </div>
            <div className="flex gap-3">
              <Button type="submit">Add Domain</Button>
              <Button type="button" variant="outline" asChild>
                <Link to={`/admin/apps/${appId}/domains`}>Cancel</Link>
              </Button>
            </div>
          </Form>
        </div>
      </div>
    </AdminShell>
  );
}
