import type { Route } from './+types/admin.apps.$appId.domains.$domainId.verify';
import { redirect } from 'react-router';
import { getDomain, enqueueVerification } from '#app/services/domain-service';
import { getOrchestrator } from '#app/services/workflows.server';
import { getUser } from '#app/middleware/helpers';

export async function loader({ params }: Route.LoaderArgs) {
  return redirect(`/admin/apps/${params.appId}/domains/${params.domainId}`);
}

export async function action({ params, context }: Route.ActionArgs) {
  getUser(context); // auth check

  const domain = await getDomain({ domainId: params.domainId, appId: params.appId });
  if (!domain) {
    throw new Response('Not Found', { status: 404 });
  }

  try {
    const boss = getOrchestrator().getBoss();
    await enqueueVerification({ domainId: domain.id, boss });
    return redirect(`/admin/apps/${params.appId}/domains/${params.domainId}?verified=1`);
  } catch {
    return redirect(`/admin/apps/${params.appId}/domains/${params.domainId}?error=verify`);
  }
}
