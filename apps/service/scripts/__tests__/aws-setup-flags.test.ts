/**
 * `pnpm setup:aws -- --dry-run` forwards the literal `--` to the script.
 */

import { describe, it, expect } from 'vitest';
import { parseFlags } from '../aws-setup';

describe('aws-setup parseFlags', () => {
  it('parses the same flags with and without the leading -- that pnpm forwards', () => {
    const expected = { dryRun: true, yes: true, writeEnv: false };
    expect(parseFlags(['--dry-run', '--yes'])).toEqual(expected);
    expect(parseFlags(['--', '--dry-run', '--yes'])).toEqual(expected);
  });

  it('still rejects positionals after the one dropped --', () => {
    expect(() => parseFlags(['--', '--', '--dry-run'])).toThrow();
    expect(() => parseFlags(['stray'])).toThrow();
  });
});
