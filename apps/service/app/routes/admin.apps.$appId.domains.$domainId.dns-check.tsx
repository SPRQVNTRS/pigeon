import type { Route } from './+types/admin.apps.$appId.domains.$domainId.dns-check';
import { getUser } from '#app/middleware/helpers';
import { getOrchestrator } from '#app/services/workflows.server';
import { enqueueDnsCheck } from '#app/workflows/dns-health-check';

export async function action({ params, context }: Route.ActionArgs) {
  getUser(context); // auth check
  const boss = getOrchestrator().getBoss();
  const jobId = await enqueueDnsCheck(boss, params.domainId);
  return Response.json({ jobId });
}

export default function DnsCheckActionRoute() {
  return null;
}
