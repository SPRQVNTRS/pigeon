import type { Route } from './+types/admin.apps.$appId.webhooks';
import type { SelectUser } from '#drizzle/schema';
import * as React from 'react';
import { Link, Form, useActionData } from 'react-router';
import { redirect } from 'react-router';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { z } from 'zod';
import { Webhook, Copy, Check } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { listWebhooks, createWebhook, generateSigningSecret } from '#app/models/webhooks.server';
import { SUPPORTED_WEBHOOK_EVENT_TYPES } from '#app/lib/webhook-events';
import { webhookUrlSchema } from '#app/lib/webhook-input';
import { checkRegistrableWebhookUrl } from '#app/lib/webhook-target';
import { isUniqueViolation } from '#app/lib/pg-errors';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';
import { withConfigChange } from '#app/models/config-change.server';
import { sessionStorage } from '#app/services/session.server';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';

export const handle = { title: 'Webhooks' };

const FLASH_KEY = 'newWebhookSecret';

const createSchema = z.object({
  url: webhookUrlSchema,
  subscribeAll: z.string().optional(), // 'on' when wildcard checkbox checked
  eventTypes: z.array(z.string()).optional(),
});

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [webhooks, app] = await Promise.all([
    listWebhooks(params.appId),
    getAppById(params.appId),
  ]);

  // Consume new-webhook-secret flash
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const newWebhookSecret = session.get(FLASH_KEY) as string | undefined;
  session.unset(FLASH_KEY);

  return new Response(
    JSON.stringify({ user, appId: params.appId, webhooks, app, newWebhookSecret: newWebhookSecret ?? null }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': await sessionStorage.commitSession(session),
      },
    },
  );
}

export async function action({ params, request, context }: Route.ActionArgs) {
  getUser(context); // auth guard
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: createSchema });

  if (submission.status !== 'success') {
    return submission.reply();
  }

  const target = await checkRegistrableWebhookUrl(submission.value.url);
  if (!target.ok) return submission.reply({ fieldErrors: { url: [target.reason] } });

  const subscribeAll = submission.value.subscribeAll === 'on';
  const eventTypes = subscribeAll ? ['*'] : (submission.value.eventTypes ?? ['*']);

  const signingSecret = generateSigningSecret();

  let webhook: Awaited<ReturnType<typeof createWebhook>>;
  try {
    // A configuration write: unconditional (the form sends no state version), but it bumps it.
    const created = await withConfigChange({
      appId: params.appId,
      expectedVersion: null,
      run: (tx) =>
        createWebhook({ appId: params.appId, url: submission.value.url, signingSecret, eventTypes }, tx),
    });
    webhook = created.result;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return submission.reply({
      fieldErrors: { url: ['A webhook with this URL already exists for this app'] },
    });
  }

  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  session.set(FLASH_KEY, signingSecret);

  return redirect(`/admin/apps/${params.appId}/webhooks/${webhook.id}`, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 hover:bg-amber-700 px-3 py-1.5 text-sm font-medium text-white transition-colors"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied!' : 'Copy Secret'}
    </button>
  );
}

function WebhookStatusPill({ enabled }: { enabled: boolean | null }) {
  const isEnabled = enabled !== false;
  const classes = isEnabled
    ? 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30'
    : 'bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-500/30';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${classes}`}>
      {isEnabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

export default function AdminAppWebhooks({ loaderData }: Route.ComponentProps) {
  const { user, appId, webhooks, app, newWebhookSecret } = loaderData as {
    user: SelectUser;
    appId: string;
    app: { id: string; name: string } | null;
    webhooks: Array<{
      id: string;
      url: string;
      eventTypes: string[] | null;
      enabled: boolean | null;
      lastSuccessAt: Date | null;
      lastFailureAt: Date | null;
    }>;
    newWebhookSecret: string | null;
  };

  const actionData = useActionData<typeof action>();
  const [form, fields] = useForm({
    lastResult: actionData && 'status' in actionData ? actionData : null,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: createSchema });
    },
    shouldValidate: 'onBlur',
  });
  const [subscribeAll, setSubscribeAll] = React.useState(false);

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Webhooks
        </h1>

        {/* One-time secret reveal */}
        {newWebhookSecret && (
          <div className="rounded-lg border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-5">
            <p className="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-200">
              Webhook signing secret: copy it now
            </p>
            <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
              This secret will <strong>not</strong> be shown again. The secret is stored securely and
              cannot be retrieved. Rotate to get a new one if you lose it.
            </p>
            <div className="flex items-center gap-3 rounded-md bg-white dark:bg-zinc-800 border border-amber-200 dark:border-amber-700 p-3 font-mono text-sm">
              <code className="flex-1 break-all text-zinc-900 dark:text-zinc-100">
                {newWebhookSecret}
              </code>
              <CopyButton text={newWebhookSecret} />
            </div>
          </div>
        )}

        {/* Create form */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">
            New Webhook
          </h2>
          <Form method="post" {...getFormProps(form)} className="space-y-4">
            <div>
              <Label
                htmlFor={fields.url.id}
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Endpoint URL
                <span className="ml-1.5 text-xs font-normal text-zinc-400">
                  HTTPS required
                </span>
              </Label>
              <Input
                {...getInputProps(fields.url, { type: 'url' })}
                placeholder="https://your-server.com/webhook"
              />
              {fields.url.errors && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  {fields.url.errors[0]}
                </p>
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Events</p>
              <label className="mb-2.5 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  name="subscribeAll"
                  value="on"
                  checked={subscribeAll}
                  onChange={(e) => setSubscribeAll(e.target.checked)}
                  className="rounded border-zinc-300 dark:border-zinc-600"
                />
                Subscribe to all events (wildcard)
              </label>
              {!subscribeAll && (
                <div className="ml-5 space-y-1.5">
                  {SUPPORTED_WEBHOOK_EVENT_TYPES.map((et) => (
                    <label
                      key={et}
                      className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        name="eventTypes"
                        value={et}
                        className="rounded border-zinc-300 dark:border-zinc-600"
                      />
                      <span className="font-mono text-xs">{et}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="sm">
                Create Webhook
              </Button>
            </div>
          </Form>
        </div>

        {/* Webhooks table */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          {webhooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Webhook size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm font-medium text-zinc-500">No webhooks yet</p>
              <p className="text-xs text-zinc-400 mt-1">
                Create a webhook endpoint to receive event notifications.
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Endpoint URL
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Events
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Last Success
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500" />
                </tr>
              </thead>
              <tbody>
                {webhooks.map((wh) => (
                  <tr
                    key={wh.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400 max-w-xs truncate">
                      {wh.url}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs font-mono">
                      {wh.eventTypes?.join(', ') ?? '*'}
                    </td>
                    <td className="px-4 py-3">
                      <WebhookStatusPill enabled={wh.enabled} />
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs tabular-nums">
                      {wh.lastSuccessAt ? new Date(wh.lastSuccessAt).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/apps/${appId}/webhooks/${wh.id}`}
                        className="text-xs font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                      >
                        View
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
