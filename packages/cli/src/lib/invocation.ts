import path from 'node:path';

/**
 * The directory the user ran the command from.
 *
 * pnpm runs a package script with the package directory as its working
 * directory and reports the directory it was started in as `INIT_CWD`. So
 * `cd my-repo && pnpm pigeon manifest validate ./pigeon.toml` has the cli
 * package as `process.cwd()`, and `INIT_CWD` is the only place that still
 * names `my-repo`. When no package runner is in between, `INIT_CWD` is unset
 * and the working directory is already right.
 *
 * Caveat: `pnpm -C <dir>` makes pnpm report `<dir>` as `INIT_CWD`, so the
 * directory you stood in when you typed the command is not known to the cli.
 *
 * Every relative path the cli reads (the manifest, `--fleet`) and the search
 * for `.env` files start here. Nothing else should read `INIT_CWD`.
 */
export function getInvocationDir(opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const initCwd = env.INIT_CWD;
  if (initCwd && path.isAbsolute(initCwd)) return initCwd;
  return cwd;
}

/** An absolute path stays as it is. A relative path is taken from the invocation directory. */
export function resolveFromInvocationDir(
  file: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string {
  return path.resolve(getInvocationDir(opts), file);
}
