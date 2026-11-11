import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEventTypes } from '../src/lib/webhook-events.js';

describe('parseEventTypes', () => {
  it('trims, drops empties and dedupes', () => {
    assert.deepEqual(parseEventTypes(' email.sent, email.sent ,,contact.subscribed'), [
      'email.sent',
      'contact.subscribed',
    ]);
  });

  it('accepts * alone', () => {
    assert.deepEqual(parseEventTypes('*'), ['*']);
  });

  it('rejects unknown types, an empty list, and * mixed with others', () => {
    assert.throws(() => parseEventTypes('email.nope'), /Unknown event type: email\.nope/);
    assert.throws(() => parseEventTypes(' , '), /at least one/);
    assert.throws(() => parseEventTypes('*,email.sent'), /alone/);
  });

  it('accepts email.received, the inbound mail event', () => {
    assert.deepEqual(parseEventTypes('email.received'), ['email.received']);
  });
});
