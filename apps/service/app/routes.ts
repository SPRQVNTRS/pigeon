import { type RouteConfig, route, layout } from '@react-router/dev/routes';

export default [
  // =============================================================================
  // Public Routes (No Auth Required)
  // =============================================================================
  route('/healthcheck', 'routes/healthcheck.ts'),
  route('/healthz', 'routes/healthz.ts'),
  route('/', 'routes/index.tsx'),
  route('/login', 'routes/login.tsx'),
  route('/logout', 'routes/logout.tsx'),
  route('/register', 'routes/register.tsx'),
  route('/forgot-password', 'routes/forgot-password.tsx'),
  route('/terms', 'routes/legal/terms.tsx'),
  route('/privacy', 'routes/legal/privacy.tsx'),

  // =============================================================================
  // Inbound webhook endpoints (no API key — SNS signature is the auth)
  // =============================================================================
  route('/v1/webhooks/ses', 'routes/api.v1.webhooks.ses.tsx'),
  route('/v1/webhooks/dmarc', 'routes/api.v1.webhooks.dmarc.tsx'),
  route('/v1/webhooks/inbound', 'routes/api.v1.webhooks.inbound.tsx'),

  // =============================================================================
  // API v1 Routes (API key auth via _api layout)
  // =============================================================================
  layout('routes/_api.tsx', { id: '_api' }, [
    // Domains
    route('/v1/domains', 'routes/api.v1.domains.tsx'),
    route('/v1/domains/:id', 'routes/api.v1.domains.$id.tsx'),
    route('/v1/domains/:id/verify', 'routes/api.v1.domains.$id.verify.tsx'),

    // Emails
    route('/v1/emails', 'routes/api.v1.emails.tsx'),
    route('/v1/emails/:id', 'routes/api.v1.emails.$id.tsx'),

    // Recipients (data erase)
    route('/v1/recipients/erase', 'routes/api.v1.recipients.erase.tsx'),

    // Audiences
    route('/v1/audiences', 'routes/api.v1.audiences.tsx'),
    route('/v1/audiences/:id', 'routes/api.v1.audiences.$id.tsx'),

    // Contacts
    route('/v1/audiences/:audienceId/contacts', 'routes/api.v1.audiences.$audienceId.contacts.tsx'),
    route('/v1/audiences/:audienceId/contacts/bulk', 'routes/api.v1.audiences.$audienceId.contacts.bulk.tsx'),
    route('/v1/audiences/:audienceId/contacts/:id', 'routes/api.v1.audiences.$audienceId.contacts.$id.tsx'),

  ]),

  // =============================================================================
  // Admin API Routes (static Bearer secret auth via _admin-api layout)
  // DMARC admin routes live here, next to the app and API key admin routes.
  // =============================================================================
  layout('routes/_admin-api.tsx', { id: '_admin_api' }, [
    // DMARC admin
    route('/v1/admin/dmarc/reports', 'routes/api.v1.admin.dmarc.reports.tsx'),
    route('/v1/admin/dmarc/reports/:id', 'routes/api.v1.admin.dmarc.reports.$id.tsx'),

    // Apps CRUD
    route('/v1/admin/apps', 'routes/api.v1.admin.apps.tsx'),
    route('/v1/admin/apps/:id', 'routes/api.v1.admin.apps.$id.tsx'),

    // Webhooks (create/list/rotate secret)
    route('/v1/admin/apps/:id/webhooks', 'routes/api.v1.admin.apps.$id.webhooks.tsx'),
    route(
      '/v1/admin/apps/:id/webhooks/:webhookId/rotate',
      'routes/api.v1.admin.apps.$id.webhooks.$webhookId.rotate.tsx',
    ),
    route('/v1/admin/apps/:id/webhooks/:webhookId', 'routes/api.v1.admin.apps.$id.webhooks.$webhookId.tsx'),

    // Read-only lists of an app's sending domains and audiences (the tenant routes' fields)
    route('/v1/admin/apps/:id/domains', 'routes/api.v1.admin.apps.$id.domains.tsx'),
    route('/v1/admin/apps/:id/audiences', 'routes/api.v1.admin.apps.$id.audiences.tsx'),

    // Inbound mail (domains, received mails, replay)
    route('/v1/admin/apps/:id/inbound-domains', 'routes/api.v1.admin.apps.$id.inbound-domains.tsx'),
    route('/v1/admin/apps/:id/inbound-emails', 'routes/api.v1.admin.apps.$id.inbound-emails.tsx'),
    route(
      '/v1/admin/apps/:id/inbound-emails/:inboundEmailId/replay',
      'routes/api.v1.admin.apps.$id.inbound-emails.$inboundEmailId.replay.tsx',
    ),

    // API keys CRUD
    route('/v1/admin/api-keys', 'routes/api.v1.admin.api-keys.tsx'),
    route('/v1/admin/api-keys/:id', 'routes/api.v1.admin.api-keys.$id.tsx'),
  ]),

  // =============================================================================
  // Admin UI Routes (session auth + admin role via _admin-ui layout middleware)
  // SIBLING to _auth, NOT nested inside it. Runs authMiddleware + adminRoleMiddleware
  // for every request under it (test/admin-ui-authorization.test.ts guards each route).
  // Coexists with _admin_api (Bearer token) — see _admin-api.tsx for the REST counterpart.
  // =============================================================================
  layout('routes/_admin-ui.tsx', { id: '_admin_ui' }, [
    // /admin → redirect to /admin/dashboard
    route('/admin', 'routes/admin._index.tsx'),
    // Dashboard (M85/06)
    route('/admin/dashboard', 'routes/admin.dashboard.tsx'),
    // Jobs & Scheduler inspector
    route('/admin/jobs', 'routes/admin.jobs.tsx'),
    route('/admin/apps', 'routes/admin.apps.tsx'),
    route('/admin/apps/new', 'routes/admin.apps.new.tsx'),
    route('/admin/apps/:id', 'routes/admin.apps.$id.tsx'),
    // Domains CRUD (M85/02)
    route('/admin/apps/:appId/domains', 'routes/admin.apps.$appId.domains.tsx'),
    route('/admin/apps/:appId/domains/new', 'routes/admin.apps.$appId.domains.new.tsx'),
    route('/admin/apps/:appId/domains/:domainId', 'routes/admin.apps.$appId.domains.$domainId.tsx'),
    route('/admin/apps/:appId/domains/:domainId/verify', 'routes/admin.apps.$appId.domains.$domainId.verify.tsx'),
    // DNS health check enqueue + poll (M76/04)
    route('/admin/apps/:appId/domains/:domainId/dns-check', 'routes/admin.apps.$appId.domains.$domainId.dns-check.tsx'),
    route('/admin/apps/:appId/domains/:domainId/dns-check/:jobId', 'routes/admin.apps.$appId.domains.$domainId.dns-check.$jobId.tsx'),
    // API Keys CRUD (M85/03)
    route('/admin/apps/:appId/keys', 'routes/admin.apps.$appId.keys.tsx'),
    route('/admin/apps/:appId/keys/:keyId/revoke', 'routes/admin.apps.$appId.keys.$keyId.revoke.tsx'),
    // Audiences & Contacts CRUD (M85/04)
    route('/admin/apps/:appId/audiences', 'routes/admin.apps.$appId.audiences.tsx'),
    route('/admin/apps/:appId/audiences/:audienceId', 'routes/admin.apps.$appId.audiences.$audienceId.tsx'),
    route('/admin/apps/:appId/audiences/:audienceId/contacts', 'routes/admin.apps.$appId.audiences.$audienceId.contacts.tsx'),
    // Webhooks CRUD (M85/05)
    route('/admin/apps/:appId/webhooks', 'routes/admin.apps.$appId.webhooks.tsx'),
    route('/admin/apps/:appId/webhooks/:webhookId', 'routes/admin.apps.$appId.webhooks.$webhookId.tsx'),
  ]),

  // =============================================================================
  // Authenticated Routes — kept minimal; /dashboard redirects to /admin/dashboard
  // =============================================================================
  layout('routes/_auth.tsx', { id: '_auth' }, [
    route('/dashboard', 'routes/dashboard.tsx'),
  ]),
] satisfies RouteConfig;
