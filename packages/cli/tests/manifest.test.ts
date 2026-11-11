import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseManifest } from '../src/lib/manifest.js';
import type { ManifestIssue } from '../src/lib/manifest.js';
import { validateManifestCommand } from '../src/commands/manifest.js';
import { FULL_MANIFEST, makeManifestIo } from './manifest-test-helpers.js';

const MINIMAL = `
schema = 1
app = "demo"

[env]
api_key = "PIGEON_API_KEY"
base_url = "PIGEON_BASE_URL"
`;

function issuesOf(text: string): ManifestIssue[] {
  const result = parseManifest(text);
  if (result.ok) throw new Error('Expected the manifest to be invalid.');
  return result.issues;
}

function issueAt(issues: ManifestIssue[], path: string): ManifestIssue {
  const issue = issues.find((entry) => entry.path === path);
  if (issue === undefined) {
    throw new Error(`No issue at ${path}. Issues: ${JSON.stringify(issues)}`);
  }
  return issue;
}

describe('parseManifest: valid files', () => {
  it('reads a full file into the typed manifest', () => {
    const result = parseManifest(FULL_MANIFEST);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.manifest, {
      schema: 1,
      app: 'my-app',
      env: { apiKey: 'PIGEON_API_KEY', baseUrl: 'PIGEON_BASE_URL' },
      domains: [{ name: 'example.test', receivesMail: true }],
      senders: [{ address: 'noreply@example.test', purpose: 'transactional', env: 'MAIL_FROM_ADDRESS' }],
      audiences: [{ name: 'product-updates', idEnv: 'PIGEON_AUDIENCE_ID', description: 'Release notes' }],
      webhooks: [
        {
          path: '/webhooks/pigeon',
          events: ['email.bounced', 'email.complained', 'email.received'],
          secretEnv: 'PIGEON_WEBHOOK_SECRET',
        },
      ],
      inbound: [{ domain: 'reply.example.test', env: null }],
      uses: { erase: true },
    });
  });

  it('treats every array section and [uses] as optional', () => {
    const result = parseManifest(MINIMAL);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.manifest.domains, []);
    assert.deepEqual(result.manifest.webhooks, []);
    assert.deepEqual(result.manifest.uses, { erase: false });
  });

  it('accepts * alone as the event list without an inbound entry', () => {
    const result = parseManifest(`${MINIMAL}
[[webhooks]]
path = "/hook"
events = ["*"]
secret_env = "HOOK_SECRET"
`);
    assert.equal(result.ok, true);
  });
});

describe('parseManifest: rules', () => {
  it('requires schema to be exactly 1', () => {
    assert.match(issueAt(issuesOf(MINIMAL.replace('schema = 1', 'schema = 2')), 'schema').message, /exactly 1/);
    assert.match(issueAt(issuesOf(MINIMAL.replace('schema = 1', 'schema = "1"')), 'schema').message, /exactly 1/);
    assert.match(issueAt(issuesOf(MINIMAL.replace('schema = 1', '')), 'schema').message, /Required/);
  });

  it('requires app, env.api_key and env.base_url', () => {
    const issues = issuesOf(`schema = 1\n[env]\n`);
    assert.match(issueAt(issues, 'app').message, /Required/);
    assert.match(issueAt(issues, 'env.api_key').message, /Required/);
    assert.match(issueAt(issues, 'env.base_url').message, /Required/);
    assert.match(issueAt(issuesOf('schema = 1\napp = "x"\n'), 'env').message, /Required/);
  });

  it('rejects unknown keys at every level', () => {
    const issues = issuesOf(`${MINIMAL.replace('[env]', 'colour = "blue"\n[env]\nsecret = "X"')}
[[domains]]
name = "example.test"
dkim = true

[uses]
erase = true
send = true
`);
    assert.match(issueAt(issues, 'colour').message, /Unknown key/);
    assert.match(issueAt(issues, 'env.secret').message, /Unknown key/);
    assert.match(issueAt(issues, 'domains[0].dkim').message, /Unknown key/);
    assert.match(issueAt(issues, 'uses.send').message, /Unknown key/);
  });

  it('rejects env names that are not names', () => {
    const issues = issuesOf(MINIMAL.replace('"PIGEON_API_KEY"', '"pigeon_api_key"'));
    assert.match(issueAt(issues, 'env.api_key').message, /Not an env var name/);
  });

  it('rejects a secret in an env-name field without echoing it', () => {
    const secret = 'ske_live_placeholder_value_0123456789';
    const issues = issuesOf(MINIMAL.replace('"PIGEON_API_KEY"', `"${secret}"`));
    const issue = issueAt(issues, 'env.api_key');
    assert.match(issue.message, /Looks like a secret\. Names only/);
    assert.equal(JSON.stringify(issues).includes(secret), false);

    const bare = issuesOf(MINIMAL.replace('"PIGEON_API_KEY"', '"AbCdEfGh0123456789XyZ"'));
    assert.match(issueAt(bare, 'env.api_key').message, /Looks like a secret/);
  });

  it('rejects a URL in an env-name field', () => {
    const issues = issuesOf(MINIMAL.replace('"PIGEON_BASE_URL"', '"http://192.0.2.1:3601"'));
    assert.match(issueAt(issues, 'env.base_url').message, /Looks like a URL\. Names only/);
  });

  it('checks env names in senders, audiences and webhooks', () => {
    const issues = issuesOf(`${MINIMAL}
[[domains]]
name = "example.test"

[[senders]]
address = "a@example.test"
purpose = "x"
env = "mail-from"

[[audiences]]
name = "news"
id_env = "https://example.test"

[[webhooks]]
path = "/hook"
events = ["email.sent"]
secret_env = "whsec_placeholder"
`);
    assert.match(issueAt(issues, 'senders[0].env').message, /Not an env var name/);
    assert.match(issueAt(issues, 'audiences[0].id_env').message, /Looks like a URL/);
    assert.match(issueAt(issues, 'webhooks[0].secret_env').message, /Looks like a secret/);
  });

  it('requires each sender domain to be a declared domain', () => {
    const issues = issuesOf(`${MINIMAL}
[[domains]]
name = "example.test"

[[senders]]
address = "noreply@other.test"
purpose = "transactional"
`);
    assert.match(issueAt(issues, 'senders[0].address').message, /other\.test is not declared/);
  });

  it('requires a sender purpose and a valid address', () => {
    const issues = issuesOf(`${MINIMAL}
[[senders]]
address = "not-an-address"
`);
    assert.match(issueAt(issues, 'senders[0].purpose').message, /Required/);
    assert.match(issueAt(issues, 'senders[0].address').message, /Not an email address/);
  });

  it('rejects unknown events, repeated events and * with others', () => {
    const issues = issuesOf(`${MINIMAL}
[[webhooks]]
path = "/a"
events = ["email.sent", "email.exploded", "email.sent"]
secret_env = "A_SECRET"

[[webhooks]]
path = "/b"
events = ["*", "email.sent"]
secret_env = "B_SECRET"
`);
    assert.match(issueAt(issues, 'webhooks[0].events[1]').message, /Unknown event type "email\.exploded"/);
    assert.match(issueAt(issues, 'webhooks[0].events[2]').message, /listed twice/);
    assert.match(issueAt(issues, 'webhooks[1].events').message, /alone/);
  });

  it('requires an [[inbound]] entry for email.received', () => {
    const issues = issuesOf(`${MINIMAL}
[[webhooks]]
path = "/hook"
events = ["email.received"]
secret_env = "HOOK_SECRET"
`);
    assert.match(issueAt(issues, 'webhooks[0].events').message, /email\.received needs at least one \[\[inbound\]\]/);
  });

  it('requires a webhook path, not a URL', () => {
    const issues = issuesOf(`${MINIMAL}
[[webhooks]]
path = "webhooks/pigeon"
events = ["email.sent"]
secret_env = "A_SECRET"

[[webhooks]]
path = "https://app.example.test/webhooks/pigeon"
events = ["email.sent"]
secret_env = "B_SECRET"
`);
    assert.match(issueAt(issues, 'webhooks[0].path').message, /start with "\/"/);
    assert.match(issueAt(issues, 'webhooks[1].path').message, /Path only/);
  });

  it('rejects duplicate domains, audiences, webhook paths and inbound domains', () => {
    const issues = issuesOf(`${MINIMAL}
[[domains]]
name = "example.test"
[[domains]]
name = "Example.TEST"

[[audiences]]
name = "news"
[[audiences]]
name = "news"

[[webhooks]]
path = "/hook"
events = ["email.sent"]
secret_env = "A_SECRET"
[[webhooks]]
path = "/hook"
events = ["email.bounced"]
secret_env = "B_SECRET"

[[inbound]]
domain = "reply.example.test"
[[inbound]]
domain = "reply.example.test"
`);
    assert.match(issueAt(issues, 'domains[1].name').message, /Duplicate domain .* domains\[0\]\.name/);
    assert.match(issueAt(issues, 'audiences[1].name').message, /Duplicate audience name/);
    assert.match(issueAt(issues, 'webhooks[1].path').message, /Duplicate webhook path/);
    assert.match(issueAt(issues, 'inbound[1].domain').message, /Duplicate inbound domain/);
  });

  it('rejects one env name used for two values', () => {
    const issues = issuesOf(`${MINIMAL}
[[webhooks]]
path = "/hook"
events = ["email.sent"]
secret_env = "PIGEON_API_KEY"
`);
    assert.match(issueAt(issues, 'webhooks[0].secret_env').message, /Duplicate env var name .* env\.api_key/);
  });

  it('reads an optional env on an [[inbound]] entry, and null when it is absent', () => {
    const result = parseManifest(`${MINIMAL}
[[inbound]]
domain = "reply.example.test"
env = "SUPPORT_REPLY_DOMAIN"
[[inbound]]
domain = "in.example.test"
`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.manifest.inbound, [
      { domain: 'reply.example.test', env: 'SUPPORT_REPLY_DOMAIN' },
      { domain: 'in.example.test', env: null },
    ]);
  });

  it('rejects an [[inbound]] env that is not a name, without echoing a URL or a secret', () => {
    const secret = 'ske_live_placeholder_value_0123456789';
    const issues = issuesOf(`${MINIMAL}
[[inbound]]
domain = "a.example.test"
env = "lower_case"
[[inbound]]
domain = "b.example.test"
env = "https://reply.example.test"
[[inbound]]
domain = "c.example.test"
env = "${secret}"
`);
    assert.match(issueAt(issues, 'inbound[0].env').message, /Not an env var name\. Names only/);
    assert.match(issueAt(issues, 'inbound[1].env').message, /Looks like a URL\. Names only/);
    assert.match(issueAt(issues, 'inbound[2].env').message, /Looks like a secret\. Names only/);
    assert.equal(JSON.stringify(issues).includes(secret), false);
    assert.equal(JSON.stringify(issues).includes('https://reply.example.test'), false);
  });

  it('rejects an [[inbound]] env that repeats another env name', () => {
    const issues = issuesOf(`${MINIMAL}
[[senders]]
address = "a@example.test"
purpose = "mail"
env = "SHARED_NAME"
[[domains]]
name = "example.test"
[[inbound]]
domain = "reply.example.test"
env = "SHARED_NAME"
`);
    assert.match(issueAt(issues, 'inbound[0].env').message, /Duplicate env var name "SHARED_NAME"\. .* senders\[0\]\.env/);
  });

  it('rejects an empty [[inbound]] env', () => {
    const issues = issuesOf(`${MINIMAL}
[[inbound]]
domain = "reply.example.test"
env = ""
`);
    assert.match(issueAt(issues, 'inbound[0].env').message, /Must not be empty/);
  });

  it('rejects a section with the wrong shape', () => {
    const issues = issuesOf(MINIMAL.replace('[env]', 'domains = "example.test"\n[env]'));
    assert.match(issueAt(issues, 'domains').message, /array of tables/);
  });

  it('reports a TOML syntax error without quoting the line', () => {
    const secret = 'ske_live_placeholder_unquoted';
    const issues = issuesOf(MINIMAL.replace('"PIGEON_API_KEY"', secret));
    assert.equal(issues.length, 1);
    assert.match(issueAt(issues, '(toml)').message, /line 6/);
    assert.equal(JSON.stringify(issues).includes(secret), false);
  });

  it('reports all issues together, each with its key path', () => {
    const issues = issuesOf(`
schema = 3
mystery = 1

[env]
api_key = "lower"

[[domains]]
name = "not a domain"

[[senders]]
address = "a@nowhere.test"
purpose = "x"

[[webhooks]]
path = "hook"
events = ["nope"]
secret_env = "HOOK_SECRET"
`);
    const paths = issues.map((issue) => issue.path);
    for (const path of [
      'schema',
      'mystery',
      'app',
      'env.api_key',
      'env.base_url',
      'domains[0].name',
      'senders[0].address',
      'webhooks[0].path',
      'webhooks[0].events[0]',
    ]) {
      assert.ok(paths.includes(path), `missing issue at ${path}: ${JSON.stringify(paths)}`);
    }
  });
});

describe('manifest validate command', () => {
  it('exits 0 on a valid file and 1 on an invalid one', () => {
    const valid = makeManifestIo();
    assert.equal(validateManifestCommand({ source: { path: 'pigeon.toml', text: FULL_MANIFEST }, isJson: false, io: valid.io }), 0);
    assert.match(valid.allOutput(), /is valid: app "my-app"/);

    const invalid = makeManifestIo();
    const code = validateManifestCommand({ source: { path: 'pigeon.toml', text: 'schema = 2\n' }, isJson: false, io: invalid.io });
    assert.equal(code, 1);
    assert.match(invalid.stderr.join(''), /schema: Must be exactly 1/);
  });

  it('prints the issues as JSON with --json', () => {
    const { io, stdout } = makeManifestIo();
    const code = validateManifestCommand({ source: { path: 'pigeon.toml', text: 'schema = 2\n' }, isJson: true, io });
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout.join('')) as { valid: boolean; issues: ManifestIssue[] };
    assert.equal(parsed.valid, false);
    assert.ok(parsed.issues.some((issue) => issue.path === 'schema'));
  });
});
