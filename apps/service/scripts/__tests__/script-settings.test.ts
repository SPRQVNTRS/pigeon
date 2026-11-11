/**
 * The AWS scripts take every deployment-specific value from the environment
 * and have no default for any of them. A missing value must stop the script
 * with a message that names the variable.
 */

import { describe, it, expect } from 'vitest';
import { readScriptSettings } from '../lib/script-settings';

const FULL_ENV = {
  PIGEON_PUBLIC_URL: 'https://pigeon.example.com',
  PIGEON_INBOUND_BUCKET: 'example-pigeon-inbound',
  PIGEON_DMARC_BUCKET: 'example-dmarc-reports',
  PIGEON_DMARC_DOMAIN: 'dmarc.example.com',
};

describe('readScriptSettings', () => {
  it('reads the named settings from the environment', () => {
    expect(readScriptSettings(['inboundBucket', 'dmarcDomain'], FULL_ENV)).toEqual({
      inboundBucket: 'example-pigeon-inbound',
      dmarcDomain: 'dmarc.example.com',
    });
  });

  it('names every missing variable in one error', () => {
    const run = () => readScriptSettings(['publicUrl', 'inboundBucket', 'dmarcBucket', 'dmarcDomain'], {});
    for (const name of Object.keys(FULL_ENV)) expect(run).toThrow(name);
  });

  it('treats a blank value as missing', () => {
    expect(() => readScriptSettings(['inboundBucket'], { PIGEON_INBOUND_BUCKET: '   ' })).toThrow(/PIGEON_INBOUND_BUCKET/);
  });

  it('does not ask for settings that were not requested', () => {
    expect(readScriptSettings(['dmarcBucket'], { PIGEON_DMARC_BUCKET: 'example-dmarc-reports' })).toEqual({
      dmarcBucket: 'example-dmarc-reports',
    });
  });

  it('strips trailing slashes from the public URL', () => {
    const env = { PIGEON_PUBLIC_URL: 'https://pigeon.example.com//' };
    expect(readScriptSettings(['publicUrl'], env).publicUrl).toBe('https://pigeon.example.com');
  });

  it('rejects a public URL that is not https', () => {
    expect(() => readScriptSettings(['publicUrl'], { PIGEON_PUBLIC_URL: 'http://pigeon.example.com' })).toThrow(/https URL/);
    expect(() => readScriptSettings(['publicUrl'], { PIGEON_PUBLIC_URL: 'pigeon.example.com' })).toThrow(/https URL/);
  });
});
