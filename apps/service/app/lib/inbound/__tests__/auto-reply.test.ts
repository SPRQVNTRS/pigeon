import { describe, it, expect } from 'vitest';
import { AUTO_REPLY_HEADER_MAX_CHARS, readAutoReply } from '../auto-reply';
import type { RawHeaderLine } from '../authentication';

/** Header lines the way mailparser emits them: lower-case key, whole line with the name. */
function lines(...raw: string[]): RawHeaderLine[] {
  return raw.map((line) => ({ key: line.slice(0, line.indexOf(':')).toLowerCase(), line }));
}

describe('readAutoReply', () => {
  it('has all nulls and is_auto false when no auto header is there', () => {
    expect(readAutoReply(lines('From: customer@example.com', 'Subject: Hello'))).toEqual({
      auto_submitted: null,
      precedence: null,
      auto_response_suppress: null,
      is_auto: false,
    });
    expect(readAutoReply([])).toEqual({
      auto_submitted: null,
      precedence: null,
      auto_response_suppress: null,
      is_auto: false,
    });
  });

  it('writes the keys in the fixed order', () => {
    const result = readAutoReply(lines('Auto-Submitted: auto-replied'));
    expect(Object.keys(result)).toEqual(['auto_submitted', 'precedence', 'auto_response_suppress', 'is_auto']);
  });

  describe('Auto-Submitted', () => {
    it('is not auto when the value is "no", in any case', () => {
      expect(readAutoReply(lines('Auto-Submitted: no'))).toMatchObject({ auto_submitted: 'no', is_auto: false });
      expect(readAutoReply(lines('Auto-Submitted: No'))).toMatchObject({ auto_submitted: 'no', is_auto: false });
    });

    it('is auto for auto-replied and auto-generated', () => {
      expect(readAutoReply(lines('Auto-Submitted: auto-replied'))).toMatchObject({
        auto_submitted: 'auto-replied',
        is_auto: true,
      });
      expect(readAutoReply(lines('Auto-Submitted: Auto-Generated'))).toMatchObject({
        auto_submitted: 'auto-generated',
        is_auto: true,
      });
    });

    it('keeps the lower-case raw value with the comment, and reads the keyword before it', () => {
      expect(readAutoReply(lines('Auto-Submitted: Auto-Replied (Vacation)'))).toMatchObject({
        auto_submitted: 'auto-replied (vacation)',
        is_auto: true,
      });
    });

    it('reads "no" before a comment or a parameter as no', () => {
      expect(readAutoReply(lines('Auto-Submitted: no (human)'))).toMatchObject({ is_auto: false });
      expect(readAutoReply(lines('Auto-Submitted: no; type=reply'))).toMatchObject({ is_auto: false });
      expect(readAutoReply(lines('Auto-Submitted: auto-replied; owner=someone'))).toMatchObject({ is_auto: true });
    });

    it('does not let a comment hide the keyword, nested or escaped', () => {
      expect(readAutoReply(lines('Auto-Submitted: (a (nested) \\) one) no'))).toMatchObject({ is_auto: false });
      expect(readAutoReply(lines('Auto-Submitted: (no) auto-replied'))).toMatchObject({ is_auto: true });
    });

    it('unfolds a folded header', () => {
      expect(readAutoReply(lines('Auto-Submitted: auto-replied\r\n (vacation)'))).toMatchObject({
        auto_submitted: 'auto-replied (vacation)',
        is_auto: true,
      });
    });

    it('counts an empty value as absent', () => {
      expect(readAutoReply(lines('Auto-Submitted:   '))).toMatchObject({ auto_submitted: null, is_auto: false });
    });
  });

  describe('Precedence', () => {
    it.each(['bulk', 'junk', 'auto_reply', 'Bulk', 'JUNK'])('is auto for %s', (value) => {
      expect(readAutoReply(lines(`Precedence: ${value}`))).toMatchObject({
        precedence: value.toLowerCase(),
        is_auto: true,
      });
    });

    it('is not auto for list, a mailing list is not an auto-reply', () => {
      expect(readAutoReply(lines('Precedence: list'))).toMatchObject({ precedence: 'list', is_auto: false });
    });

    it('is not auto for an unknown keyword', () => {
      expect(readAutoReply(lines('Precedence: first-class'))).toMatchObject({ is_auto: false });
    });
  });

  describe('X-Auto-Response-Suppress', () => {
    it('is auto for any non-empty value', () => {
      expect(readAutoReply(lines('X-Auto-Response-Suppress: All'))).toMatchObject({
        auto_response_suppress: 'all',
        is_auto: true,
      });
      expect(readAutoReply(lines('X-Auto-Response-Suppress: OOF, DR, RN'))).toMatchObject({
        auto_response_suppress: 'oof, dr, rn',
        is_auto: true,
      });
    });

    it('is not auto when the value is empty', () => {
      expect(readAutoReply(lines('X-Auto-Response-Suppress:'))).toMatchObject({
        auto_response_suppress: null,
        is_auto: false,
      });
    });
  });

  it('reads each header on its own, one auto header is enough', () => {
    expect(
      readAutoReply(lines('Auto-Submitted: no', 'Precedence: list', 'X-Auto-Response-Suppress: all')),
    ).toEqual({ auto_submitted: 'no', precedence: 'list', auto_response_suppress: 'all', is_auto: true });
  });

  describe('cap', () => {
    it('cuts each stored value to the cap', () => {
      const long = 'x'.repeat(1000);
      const result = readAutoReply(
        lines(`Auto-Submitted: auto-replied ${long}`, `Precedence: bulk ${long}`, `X-Auto-Response-Suppress: ${long}`),
      );
      expect(AUTO_REPLY_HEADER_MAX_CHARS).toBe(200);
      expect(result.auto_submitted).toHaveLength(AUTO_REPLY_HEADER_MAX_CHARS);
      expect(result.precedence).toHaveLength(AUTO_REPLY_HEADER_MAX_CHARS);
      expect(result.auto_response_suppress).toHaveLength(AUTO_REPLY_HEADER_MAX_CHARS);
      expect(result.auto_submitted?.startsWith('auto-replied x')).toBe(true);
    });

    it('decides on the whole value, so a long comment cannot hide the keyword', () => {
      const comment = `(${'c'.repeat(1000)})`;
      const result = readAutoReply(lines(`Auto-Submitted: ${comment} auto-replied`));
      expect(result.auto_submitted).toHaveLength(AUTO_REPLY_HEADER_MAX_CHARS);
      expect(result.is_auto).toBe(true);
    });

    it('decides on the whole value in the other direction too: "no" after a long comment stays not auto', () => {
      const comment = `(${'c'.repeat(1000)})`;
      const result = readAutoReply(lines(`Auto-Submitted: ${comment} no`, `Precedence: ${comment} bulk`));
      expect(result.auto_submitted).toHaveLength(AUTO_REPLY_HEADER_MAX_CHARS);
      expect(readAutoReply(lines(`Auto-Submitted: ${comment} no`)).is_auto).toBe(false);
      expect(result.is_auto).toBe(true);
    });

    it('never cuts a surrogate pair in half', () => {
      const result = readAutoReply(lines(`X-Auto-Response-Suppress: ${'a'.repeat(AUTO_REPLY_HEADER_MAX_CHARS - 1)}😀`));
      expect(result.auto_response_suppress).toBe('a'.repeat(AUTO_REPLY_HEADER_MAX_CHARS - 1));
    });
  });

  describe('repeated headers', () => {
    it('takes the first occurrence of Auto-Submitted', () => {
      expect(readAutoReply(lines('Auto-Submitted: no', 'Auto-Submitted: auto-replied'))).toMatchObject({
        auto_submitted: 'no',
        is_auto: false,
      });
      expect(readAutoReply(lines('Auto-Submitted: auto-replied', 'Auto-Submitted: no'))).toMatchObject({
        auto_submitted: 'auto-replied',
        is_auto: true,
      });
    });

    it('takes the first occurrence of Precedence and X-Auto-Response-Suppress', () => {
      expect(readAutoReply(lines('Precedence: list', 'Precedence: bulk'))).toMatchObject({
        precedence: 'list',
        is_auto: false,
      });
      expect(readAutoReply(lines('X-Auto-Response-Suppress: oof', 'X-Auto-Response-Suppress: all'))).toMatchObject({
        auto_response_suppress: 'oof',
      });
    });
  });

  it('matches the header name in any case', () => {
    const result = readAutoReply([{ key: 'AUTO-SUBMITTED', line: 'AUTO-SUBMITTED: auto-generated' }]);
    expect(result).toMatchObject({ auto_submitted: 'auto-generated', is_auto: true });
  });
});
