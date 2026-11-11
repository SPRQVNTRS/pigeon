import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../src/lib/manifest.js';

const EXAMPLE_PATH = fileURLToPath(new URL('../examples/example.pigeon.toml', import.meta.url));

describe('examples/example.pigeon.toml', () => {
  const result = parseManifest(readFileSync(EXAMPLE_PATH, 'utf8'));

  it('is a valid schema 1 manifest', () => {
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  });

  it('uses every section of schema 1', () => {
    assert.ok(result.ok);
    const { manifest } = result;
    assert.equal(manifest.app, 'my-app');
    assert.ok(manifest.domains.some((domain) => domain.receivesMail));
    assert.ok(manifest.domains.some((domain) => !domain.receivesMail));
    assert.ok(manifest.senders.some((sender) => sender.env !== null));
    assert.ok(manifest.senders.some((sender) => sender.env === null));
    assert.ok(manifest.audiences.some((audience) => audience.idEnv !== null && audience.description !== null));
    assert.ok(manifest.webhooks.length > 0);
    assert.ok(manifest.inbound.some((inbound) => inbound.env !== null));
    assert.equal(manifest.uses.erase, true);
  });
});
