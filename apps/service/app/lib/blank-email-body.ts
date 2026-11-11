/**
 * The values an `emails` row holds once its body is gone.
 *
 * One definition for both ways a body disappears: the retention pass (age) and
 * the email.send worker (a mail sent with `retain_body: false`). `headers`
 * goes with the body because custom headers can carry a link or a token.
 * `{}` is the column default, so a blanked row looks like one that never had
 * headers.
 */
export const BLANKED_EMAIL_BODY = {
  html: null,
  text: null,
  headers: {},
} as const;
