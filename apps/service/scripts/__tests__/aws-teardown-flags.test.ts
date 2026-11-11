/**
 * `pnpm teardown:aws -- --yes` forwards the literal `--` to the script.
 */

import { describe, it, expect } from 'vitest';
import { parseFlags } from '../aws-teardown';

describe('aws-teardown parseFlags', () => {
  it('parses the flags after the leading -- that pnpm forwards', () => {
    const expected = { yes: true, confirmWord: 'x' };
    expect(parseFlags(['--yes', '--confirm-word', 'x'])).toEqual(expected);
    expect(parseFlags(['--', '--yes', '--confirm-word', 'x'])).toEqual(expected);
  });

  it('still rejects positionals after the one dropped --', () => {
    expect(() => parseFlags(['--', '--', '--yes'])).toThrow();
    expect(() => parseFlags(['stray'])).toThrow();
  });
});
