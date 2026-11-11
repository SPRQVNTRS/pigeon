// =============================================================================
// Schema Barrel Export
// =============================================================================

// Users (includes workflow table re-exports)
export * from './users';

// Apps (anchor for app_id values)
export * from './apps';

// API Keys
export * from './api-keys';

// Domains
export * from './domains';

// Emails
export * from './emails';

// Email Events
export * from './email-events';

// Audiences
export * from './audiences';

// Contacts
export * from './contacts';

// Suppressions
export * from './suppressions';

// Webhooks
export * from './webhooks';

// Idempotent Requests
export * from './idempotent-requests';

// DMARC Reports
export * from './dmarc';

// DNS Check Results
export * from './dns-check-results';

// Inbound mail (SES receiving)
export * from './inbound';
