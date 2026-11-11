import { describe, it, expect } from 'vitest';
import { groupRecipientsByDomain, recipientDomain, recipientDomains } from '../recipients';

const KLARA = { id: 'dom_a', appId: 'app_a', name: 'reply.example.test' };
const OTHER = { id: 'dom_b', appId: 'app_b', name: 'in.example.com' };

describe('recipientDomain', () => {
  it('takes the part after the last @, lower case', () => {
    expect(recipientDomain('A.User@Reply.Example.TEST')).toBe('reply.example.test');
    expect(recipientDomain('"odd@local"@reply.example.test')).toBe('reply.example.test');
  });

  it('returns null for an address without a domain', () => {
    expect(recipientDomain('nobody')).toBeNull();
    expect(recipientDomain('@reply.example.test')).toBeNull();
    expect(recipientDomain('user@')).toBeNull();
  });
});

describe('groupRecipientsByDomain', () => {
  it('groups by domain case-insensitively and counts unknown recipients', () => {
    const result = groupRecipientsByDomain({
      recipients: [
        'kc-a@reply.example.test',
        'KC-B@REPLY.EXAMPLE.TEST',
        'x@in.example.com',
        'stranger@unrelated.example.com',
        'broken',
      ],
      domains: [KLARA, OTHER],
    });
    expect(result.unmatchedCount).toBe(2);
    expect(result.groups).toEqual([
      { domain: KLARA, recipients: ['kc-a@reply.example.test', 'KC-B@REPLY.EXAMPLE.TEST'] },
      { domain: OTHER, recipients: ['x@in.example.com'] },
    ]);
  });

  it('never matches a subdomain or a parent domain', () => {
    const result = groupRecipientsByDomain({
      recipients: ['a@sub.reply.example.test', 'b@example.test'],
      domains: [KLARA],
    });
    expect(result.groups).toEqual([]);
    expect(result.unmatchedCount).toBe(2);
  });

  it('dedupes a recipient listed twice', () => {
    const result = groupRecipientsByDomain({
      recipients: ['kc-a@reply.example.test', 'kc-a@reply.example.test'],
      domains: [KLARA],
    });
    expect(result.groups[0]?.recipients).toEqual(['kc-a@reply.example.test']);
  });

  it('recipientDomains lists each domain once', () => {
    expect(recipientDomains(['a@X.example', 'b@x.example', 'c@y.example', 'bad'])).toEqual(['x.example', 'y.example']);
  });
});
