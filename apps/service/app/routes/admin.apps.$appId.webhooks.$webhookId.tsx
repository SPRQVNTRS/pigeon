import type { Route } from './+types/admin.apps.$appId.webhooks.$webhookId';
import type { SelectUser } from '#drizzle/schema';
import * as React from 'react';
import { Form, useActionData } from 'react-router';
import { redirect } from 'react-router';
import { eq, and } from 'drizzle-orm';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { z } from 'zod';
import { Copy, Check } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { updateWebhook, generateSigningSecret } from '#app/models/webhooks.server';
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
import { db } from '#drizzle/db';
import { webhooks } from '#drizzle/schema/index';
import type { SelectWebhook } from '#drizzle/schema/index';

export const handle = { title: 'Webhook' };

const FLASH_KEY = 'newWebhookSecret';

async function getWebhookById(id: string, appId: string): Promise<SelectWebhook | null> {
  const [webhook] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.appId, appId)))
    .limit(1);
  return webhook ?? null;
}

const editSchema = z.object({
  url: webhookUrlSchema,
  subscribeAll: z.string().optional(),
  eventTypes: z.array(z.string()).optional(),
});

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [webhook, app] = await Promise.all([
    getWebhookById(params.webhookId, params.appId),
    getAppById(params.appId),
  ]);
  if (!webhook) {
    throw new Response('Not Found', { status: 404 });
  }

  // Consume rotate-secret flash
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const newWebhookSecret = session.get(FLASH_KEY) as string | undefined;
  session.unset(FLASH_KEY);

  return new Response(
    JSON.stringify({ user, webhook, appId: params.appId, app, newWebhookSecret: newWebhookSecret ?? null }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': await sessionStorage.commitSession(session),
      },
    },
  );
}

type WebhookChange = Parameters<typeof updateWebhook>[2];

/**
 * Every form intent here changes the app's configuration, so each one goes
 * through withConfigChange: unconditional (the form sends no state version),
 * but it bumps it.
 */
async function changeWebhook(opts: { appId: string; webhookId: string; data: WebhookChange }): Promise<void> {
  const { appId, webhookId, data } = opts;
  await withConfigChange({
    appId,
    expectedVersion: null,
    run: (tx) => updateWebhook(webhookId, appId, data, tx),
  });
}

export async function action({ params, request, context }: Route.ActionArgs) {
  getUser(context); // auth guard
  const formData = await request.formData();
  const intent = formData.get('intent') as string | null;

  switch (intent) {
    case 'edit': {
      const submission = parseWithZod(formData, { schema: editSchema });
      if (submission.status !== 'success') {
        return submission.reply();
      }
      const target = await checkRegistrableWebhookUrl(submission.value.url);
      if (!target.ok) return submission.reply({ fieldErrors: { url: [target.reason] } });
      const subscribeAll = submission.value.subscribeAll === 'on';
      const eventTypes = subscribeAll ? ['*'] : (submission.value.eventTypes ?? ['*']);
      try {
        await changeWebhook({
          appId: params.appId,
          webhookId: params.webhookId,
          data: { url: submission.value.url, eventTypes },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        return submission.reply({
          fieldErrors: { url: ['A webhook with this URL already exists for this app'] },
        });
      }
      return redirect(`/admin/apps/${params.appId}/webhooks/${params.webhookId}?updated=1`);
    }

    case 'disable': {
      await changeWebhook({ appId: params.appId, webhookId: params.webhookId, data: { enabled: false } });
      return redirect(`/admin/apps/${params.appId}/webhooks/${params.webhookId}`);
    }

    case 'enable': {
      await changeWebhook({ appId: params.appId, webhookId: params.webhookId, data: { enabled: true } });
      return redirect(`/admin/apps/${params.appId}/webhooks/${params.webhookId}`);
    }

    case 'rotate-secret': {
      const newSecret = generateSigningSecret();
      await changeWebhook({ appId: params.appId, webhookId: params.webhookId, data: { signingSecret: newSecret } });
      const session = await sessionStorage.getSession(request.headers.get('cookie'));
      session.set(FLASH_KEY, newSecret);
      return redirect(`/admin/apps/${params.appId}/webhooks/${params.webhookId}`, {
        headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
      });
    }

    default:
      throw new Response('Bad Request', { status: 400 });
  }
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

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 space-y-4">
      <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h2>
      {children}
    </div>
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

export default function AdminWebhookDetail({ loaderData }: Route.ComponentProps) {
  const { user, webhook, appId, app, newWebhookSecret } = loaderData as {
    user: SelectUser;
    appId: string;
    app: { id: string; name: string } | null;
    webhook: SelectWebhook;
    newWebhookSecret: string | null;
  };

  const actionData = useActionData<typeof action>();
  const [subscribeAll, setSubscribeAll] = React.useState(
    webhook.eventTypes?.includes('*') ?? false,
  );
  const [form, fields] = useForm({
    lastResult: actionData && 'status' in actionData ? actionData : null,
    defaultValue: { url: webhook.url },
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: editSchema });
    },
    shouldValidate: 'onBlur',
  });

  return (
    <AdminShell user={user} currentApp={app}>
      <div className="space-y-6 max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Webhook
        </h1>

        {/* Rotate-secret reveal */}
        {newWebhookSecret && (
          <div className="rounded-lg border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-5">
            <p className="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-200">
              New signing secret: copy it now
            </p>
            <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
              The old secret has been immediately invalidated. Update your consumer code before the
              next delivery. This secret cannot be retrieved again.
            </p>
            <div className="flex items-center gap-3 rounded-md bg-white dark:bg-zinc-800 border border-amber-200 dark:border-amber-700 p-3 font-mono text-sm">
              <code className="flex-1 break-all text-zinc-900 dark:text-zinc-100">
                {newWebhookSecret}
              </code>
              <CopyButton text={newWebhookSecret} />
            </div>
          </div>
        )}

        {/* Endpoint Configuration */}
        <SectionCard title="Endpoint Configuration">
          <Form method="post" {...getFormProps(form)} className="space-y-4">
            <input type="hidden" name="intent" value="edit" />
            <div>
              <Label
                htmlFor={fields.url.id}
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Endpoint URL
              </Label>
              <Input {...getInputProps(fields.url, { type: 'url' })} />
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
                  defaultChecked={webhook.eventTypes?.includes('*')}
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
                        defaultChecked={webhook.eventTypes?.includes(et)}
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
                Save Changes
              </Button>
            </div>
          </Form>
        </SectionCard>

        {/* Status */}
        <SectionCard title="Status">
          <div className="flex items-center gap-4">
            <WebhookStatusPill enabled={webhook.enabled} />
            <Form method="post">
              <input type="hidden" name="intent" value={webhook.enabled ? 'disable' : 'enable'} />
              <button
                type="submit"
                className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                onClick={(e) => {
                  if (
                    webhook.enabled &&
                    !window.confirm(
                      'Disable this webhook? No events will be delivered until re-enabled.',
                    )
                  ) {
                    e.preventDefault();
                  }
                }}
              >
                {webhook.enabled ? 'Disable' : 'Enable'}
              </button>
            </Form>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-1">
                Last successful delivery
              </p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 tabular-nums">
                {webhook.lastSuccessAt
                  ? new Date(webhook.lastSuccessAt).toLocaleString()
                  : 'Never'}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-1">
                Last failed delivery
              </p>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 tabular-nums">
                {webhook.lastFailureAt
                  ? new Date(webhook.lastFailureAt).toLocaleString()
                  : 'Never'}
              </p>
            </div>
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Delivery history is not yet available in the UI. Check application logs for delivery details.
          </p>
        </SectionCard>

        {/* Signing Secret */}
        <SectionCard title="Signing Secret">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            The signing secret is stored securely and cannot be retrieved. To get a new secret,
            rotate below. The old secret will be immediately invalidated.
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="rotate-secret" />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              onClick={(e) => {
                if (
                  !window.confirm(
                    'Rotate signing secret? The current secret will be immediately invalidated. Update your consumer code first.',
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              Rotate Signing Secret
            </Button>
          </Form>
        </SectionCard>
      </div>
    </AdminShell>
  );
}
