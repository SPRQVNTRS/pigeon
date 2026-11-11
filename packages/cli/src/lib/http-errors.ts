/**
 * A non-2xx answer to a call whose success body carries a secret.
 * The message holds the status, the error code and the server message only.
 * It never holds the raw body.
 */
export class PigeonHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(opts: { status: number; code: string | null; message: string }) {
    super(opts.message);
    this.name = 'PigeonHttpError';
    this.status = opts.status;
    this.code = opts.code;
  }
}
