import type { Route } from './+types/admin.apps.$appId.keys';
import type { SelectUser } from '#drizzle/schema';
import * as React from 'react';
import { Form, useActionData } from 'react-router';
import { redirect } from 'react-router';
import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import { z } from 'zod';
import { KeyRound, Copy, Check } from 'lucide-react';
import AdminShell from '#app/components/admin-shell';
import { listApiKeys, createApiKey } from '#app/models/api-keys.server';
import { getUser } from '#app/middleware/helpers';
import { getAppById } from '#app/models/apps.server';
import { toPublicApiKey } from '#app/lib/api-key-public';
import { sessionStorage } from '#app/services/session.server';
import { Button } from '#app/components/ui/button';
import { Input } from '#app/components/ui/input';
import { Label } from '#app/components/ui/label';

export const handle = { title: 'API Keys' };

const FLASH_KEY = 'newApiKey';

const createSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
});

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const user = getUser(context);
  const [keys, app] = await Promise.all([
    listApiKeys(params.appId),
    getAppById(params.appId),
  ]);

  // Read and consume the one-time flash key
  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  const newApiKey = session.get(FLASH_KEY) as string | undefined;
  session.unset(FLASH_KEY);

  // Read and consume revoked flash
  const revokedFlash = session.get('revokedKey') as boolean | undefined;
  session.unset('revokedKey');

  return new Response(
    JSON.stringify({
      user,
      appId: params.appId,
      keys: keys.map(toPublicApiKey),
      app,
      newApiKey: newApiKey ?? null,
      revokedFlash: revokedFlash ?? false,
    }),
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

  const { plaintext } = await createApiKey({
    appId: params.appId,
    name: submission.value.name,
  });

  const session = await sessionStorage.getSession(request.headers.get('cookie'));
  session.set(FLASH_KEY, plaintext);

  return redirect(`/admin/apps/${params.appId}/keys`, {
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
      {copied ? 'Copied!' : 'Copy Key'}
    </button>
  );
}

type KeyStatus = 'active' | 'revoked';

function KeyStatusPill({ status }: { status: KeyStatus }) {
  const classes =
    status === 'active'
      ? 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-900/20 dark:text-green-300 dark:ring-green-400/30'
      : 'bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-500/30';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${classes}`}>
      {status === 'active' ? 'Active' : 'Revoked'}
    </span>
  );
}

export default function AdminAppKeys({ loaderData }: Route.ComponentProps) {
  const { user, appId, keys, app, newApiKey, revokedFlash } = loaderData as {
    user: SelectUser;
    appId: string;
    app: { id: string; name: string } | null;
    keys: Array<{
      id: string;
      name: string;
      prefix: string;
      createdAt: Date;
      revokedAt: Date | null;
    }>;
    newApiKey: string | null;
    revokedFlash: boolean;
  };

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
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          API Keys
        </h1>

        {/* One-time reveal panel */}
        {newApiKey && (
          <div className="rounded-lg border-2 border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-5">
            <p className="mb-1 text-sm font-semibold text-amber-900 dark:text-amber-200">
              Your new API key: copy it now
            </p>
            <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">
              This key will <strong>not</strong> be shown again. Store it securely.
              If you navigate away without copying, you will need to revoke this key and create a new one.
            </p>
            <div className="flex items-center gap-3 rounded-md bg-white dark:bg-zinc-800 border border-amber-200 dark:border-amber-700 p-3 font-mono text-sm">
              <code className="flex-1 break-all text-zinc-900 dark:text-zinc-100">{newApiKey}</code>
              <CopyButton text={newApiKey} />
            </div>
          </div>
        )}

        {/* Post-revoke confirmation */}
        {revokedFlash && (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
            Key revoked successfully.
          </div>
        )}

        {/* Create form */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">
            Create API Key
          </h2>
          <Form method="post" {...getFormProps(form)} className="flex items-end gap-3">
            <div className="flex-1">
              <Label
                htmlFor={fields.name.id}
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Key Name
              </Label>
              <Input
                {...getInputProps(fields.name, { type: 'text' })}
                placeholder="e.g. Production, CI/CD"
              />
              {fields.name.errors && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
                  {fields.name.errors[0]}
                </p>
              )}
            </div>
            <Button type="submit" size="sm">
              Create Key
            </Button>
          </Form>
        </div>

        {/* Keys table */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          {keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <KeyRound size={40} className="text-zinc-300 dark:text-zinc-600 mb-3" />
              <p className="text-sm font-medium text-zinc-500">No API keys yet</p>
              <p className="text-xs text-zinc-400 mt-1">
                Create a key to start using the pigeon API.
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
                    Prefix
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-zinc-500" />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr
                    key={key.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {key.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500 tabular-nums">
                      {key.prefix}…
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 tabular-nums">
                      {new Date(key.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <KeyStatusPill status={key.revokedAt ? 'revoked' : 'active'} />
                    </td>
                    <td className="px-4 py-3">
                      {!key.revokedAt && (
                        <Form
                          method="post"
                          action={`/admin/apps/${appId}/keys/${key.id}/revoke`}
                          onSubmit={(e) => {
                            if (!window.confirm(`Revoke key "${key.name}"? This cannot be undone.`)) {
                              e.preventDefault();
                            }
                          }}
                        >
                          <button
                            type="submit"
                            className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                          >
                            Revoke
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

        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          To rotate a key: revoke the existing key and create a new one.
        </p>
      </div>
    </AdminShell>
  );
}
