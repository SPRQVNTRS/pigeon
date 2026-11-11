import { describe, it, expect } from 'vitest';
import { isSnsSubscribeUrl } from '../subscribe-url';

describe('isSnsSubscribeUrl', () => {
  it.each([
    'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
    'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
    'https://SNS.EU-CENTRAL-1.AMAZONAWS.COM/?Action=ConfirmSubscription',
    'https://sns.eu-central-1.amazonaws.com:443/?Action=ConfirmSubscription',
  ])('accepts %s', (url) => {
    expect(isSnsSubscribeUrl(url)).toBe(true);
  });

  it.each([
    ['http scheme', 'http://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription'],
    ['another host', 'https://attacker.example/?Action=ConfirmSubscription'],
    ['another AWS host', 'https://s3.eu-central-1.amazonaws.com/'],
    ['a port', 'https://sns.eu-central-1.amazonaws.com:8443/'],
    ['a user name', 'https://user@sns.eu-central-1.amazonaws.com/'],
    ['a user name and password', 'https://user:pw@sns.eu-central-1.amazonaws.com/'],
    ['userinfo that looks like the host', 'https://sns.eu-central-1.amazonaws.com@attacker.example/'],
    ['a lookalike host', 'https://sns.eu-central-1.amazonaws.com.evil.example/'],
    ['a lookalike suffix', 'https://sns.eu-central-1.amazonaws.com.evil.example:443/'],
    ['a prefixed host', 'https://evilsns.eu-central-1.amazonaws.com/'],
    ['a trailing dot', 'https://sns.eu-central-1.amazonaws.com./'],
    ['the host in the query only', 'https://attacker.example/?sns.eu-central-1.amazonaws.com'],
    ['no URL at all', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(isSnsSubscribeUrl(url)).toBe(false);
  });
});
