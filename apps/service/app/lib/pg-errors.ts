const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when the error is a Postgres unique violation (SQLSTATE 23505).
 * Drizzle >= 0.44 wraps driver errors in DrizzleQueryError and keeps the
 * original pg error on `cause`, so the whole cause chain is checked.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ('code' in current && current.code === PG_UNIQUE_VIOLATION) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * True when the error is a unique violation of the named constraint or unique
 * index. pg puts the name on `constraint`; the cause chain is walked as above.
 */
export function isUniqueViolationOf(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    const isMatch =
      'code' in current &&
      current.code === PG_UNIQUE_VIOLATION &&
      'constraint' in current &&
      current.constraint === constraint;
    if (isMatch) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
