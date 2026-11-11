/**
 * pnpm 11 forwards the `--` of `pnpm <script> -- --flag` to the script, and
 * parseArgs reads everything after it as positionals. Drop one leading `--`
 * so the documented form works.
 */
export function withoutLeadingSeparator(argv: readonly string[]): string[] {
  const [first, ...rest] = argv;
  if (first === '--') return rest;
  return [...argv];
}
