import type { Route } from './+types/admin.apps.$appId.domains.$domainId.dns-check.$jobId';
import { getUser } from '#app/middleware/helpers';
import { getOrchestrator } from '#app/services/workflows.server';
import { getDnsCheckJobStatus } from '#app/workflows/dns-health-check';

export async function loader({ params, context }: Route.LoaderArgs) {
  getUser(context); // auth check
  const boss = getOrchestrator().getBoss();
  const status = await getDnsCheckJobStatus(boss, params.jobId);
  return Response.json({ status });
}

export default function DnsCheckPollRoute() {
  return null;
}
